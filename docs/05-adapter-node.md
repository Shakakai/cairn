# 05 — `packages/adapter-node`

A Node 24 HTTP + WebSocket server implementing `SocketHost`. One process per container. With
`router-memory` it is a complete single-instance relay; with `router-redis` it scales out as a
container pool on AWS ECS/Fargate, GCP Cloud Run, Azure Container Apps, Kubernetes or VMs.

## Process layout

```
main.ts
  load config (doc 10) → build Router (memory | redis) → start servers
servers
  relay listener   : HTTP (offload mode) or HTTPS (terminate mode); routes doc 01 §2
  plain listener   : HTTP for /v1/captive when the relay listener is HTTPS (terminate mode only)
  admin listener   : /metrics (Prometheus), /readyz, /livez on a private port (default 9090)
```

### TLS modes

| `tls.mode` | Who terminates TLS | Use when |
| --- | --- | --- |
| `offload` (default) | Load balancer / platform | Cloud Run, Container Apps, NLB TLS listener, ALB |
| `terminate` | This process (`https.createServer`, cert/key from files or a secret) | VMs, NLB TCP pass-through |

Auth is in the upgrade request (doc 01 §3.2), so it works the same in both modes.

In `offload` mode a single plain-HTTP port serves everything; the load balancer maps 443 (TLS)
and 80 (plain) to it.

## WebSocket server

Use `ws` with `noServer: true`:

```ts
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 1 << 20,          // doc 01: 1 MiB
  perMessageDeflate: false,
  handleProtocols: (offered) => (offered.has("switchback.v1") ? "switchback.v1" : false),
});
server.on("upgrade", async (req, socket, head) => {
  if (draining) return writeHttpError(socket, { status: 503, body: "draining" });
  const decision = negotiateUpgrade(fromIncomingMessage(req), env());
  if (!decision.ok) return writeHttpError(socket, decision);                 // raw HTTP response, then destroy
  if (!(await router.claimNonce(decision.endpoint, decision.nonce, 2 * cfg.authSkewMs)))
    return writeHttpError(socket, { status: 401, body: "auth: replay" });
  if (!(await policy.allow(decision.endpoint, decision.token)))
    return writeHttpError(socket, { status: 403, body: "access denied" });
  wss.handleUpgrade(req, socket, head, ws => onConnection(ws, decision));
});
```

`handleProtocols`: return `"switchback.v1"` when offered (negotiateUpgrade already checked), so
the 101 carries `Sec-WebSocket-Protocol`.

Server keepalive (`caps.serverPings = true`): `ws.ping()` every `serverPingMs` (30 s); terminate a
socket whose pong hasn't arrived within `serverPongTimeoutMs` (10 s). Client pings are answered
by `ws` automatically.

## Connection runtime

Per connection keep `{ ws, state, timer, pendingData, pendingControl, registering, buffered[] }`.

- **Serialization:** steps for one connection run one at a time (a tiny per-conn promise chain).
- **Sends:** `ws.send(bytes, { binary: true }, cb)`. Count frames in flight; if `pendingData`
  ≥ 512 drop new `data` frames (metric `relay_frames_dropped_total{reason="queue_full"}`);
  `pendingControl` cap 64. Start a 2 s timer per send batch; if callbacks haven't drained within
  2 s (`config.writeTimeoutMs`), close with 1011 (doc 01 §5.2).
- **Backpressure on reads** (rate limiting): `caps.canPauseReads = true`; when the core reports a
  conn is over its byte budget, call `ws.pause()`; `ws.resume()` when the bucket refills.
- **Registering window:** between the `register` effect and `router.register()` resolving, buffer
  `deliver`/`notify` calls for that conn (max 64 frames) and apply them, notices first, after it
  resolves. This closes the race between the Redis command reply and pub/sub delivery (doc 06).
- **Timers:** one `setTimeout` per conn, replaced on each `timer` effect.

## Router wiring

```ts
const router = config.router.kind === "redis"
  ? await RedisRouter.connect(config.router.redis, host)     // doc 06
  : new MemoryRouter(host);
```

`host` is this process's `SocketHost` implementation (`deliver`, `notify`). `hostId` =
`config.instanceId ?? `${platformInstanceId()}-${random6}`` where `platformInstanceId()` reads
`ECS_CONTAINER_METADATA_URI_V4` (task id), `K_REVISION`+hostname on Cloud Run,
`CONTAINER_APP_REPLICA_NAME` on Container Apps, else `os.hostname()`.

Local fast path: before `router.route()`, check whether `dst`'s active connection is in this
process (`router.localActive(dst)` returns the local `ConnRef` if it is active here).

## Health and lifecycle

| Endpoint | Port | Meaning |
| --- | --- | --- |
| `/healthz` | relay port | JSON per doc 01 §2. Always 200 while the process runs. |
| `/livez` | admin | 200 if the event loop is responsive (loop delay < 1 s). |
| `/readyz` | admin | 200 if accepting connections and the router is connected; 503 while draining. |
| `/metrics` | admin | Prometheus text format (doc 10). |

Point platform health checks at `/readyz` where the platform allows a separate port. Where probes
must use the serving port (Cloud Run, Container Apps), use `/healthz?ready=1`, which returns 503
while draining or while the router is disconnected.

### Graceful shutdown (SIGTERM)

1. Mark not ready (`/readyz` → 503), stop accepting new upgrades (respond 503).
2. For each connection, schedule `drain` at a random offset within `drainWindowMs` (default 8 s,
   chosen to fit Cloud Run's 10 s SIGTERM grace; raise on ECS where `stopTimeout` allows up to 120 s).
   `drain` sends `Restarting` then closes with 1012. Our clients reconnect make-before-break
   (doc 01 §4.6), usually landing on another instance via the load balancer.
3. `router.close()`; exit.

## Platform notes

| Platform | Settings this adapter expects |
| --- | --- |
| **Cloud Run** | `PORT` env (single port, offload mode); request timeout 3600 s; set `caps.maxConnectionMs = 3_600_000` so the core closes cleanly before the cut; concurrency up to 1000; CPU always allocated; session affinity on (best effort). |
| **ECS/Fargate + NLB** | NLB TLS listener (ACM) :443 → 8080 and TCP :80 → 8080 (offload mode). NLB TCP idle timeout (350 s default) is far above the 15 s client ping. |
| **Container Apps** | Ingress external, target port 8080, HTTP transport, allow insecure (for `/v1/captive` on port 80). Verify ingress idle timeout and any max request duration in M6; set `caps.maxConnectionMs` if one exists. |
| **VMs / k8s** | Either mode. For k8s use a `LoadBalancer` service (L4) to keep WebSockets simple. |

## Dockerfile (`deploy/docker/Dockerfile`)

- Multi-stage: build with pnpm, run on `node:24-slim`, non-root user, `tini` as PID 1.
- `EXPOSE 8080 8443 9090`. `CMD ["node", "packages/adapter-node/dist/main.js"]`.
- Multi-arch image (`linux/amd64`, `linux/arm64`) — ARM (Graviton, Ampere/Axion) is cheaper for this workload.

## Tests

- Unit: upgrade handling (400 paths, subprotocol header), send queue limits, write timeout,
  pause/resume, registering-window buffering, drain ordering.
- Integration: two adapter instances + one Redis (Testcontainers) + raw relay clients.
- E2E: `tools/e2e` (our Rust client) against `pnpm --filter @cairn/adapter-node dev` (doc 08).
