# 04 — `packages/adapter-cloudflare`

Client WebSockets terminate in a **Worker** at the client's nearest PoP (the SocketHost). One
**Mailbox Durable Object** per EndpointId routes frames to that endpoint's connections (Router
semantics). ADR-002.

Billing facts this design follows (Cloudflare docs, Oct 2026):
- WebSocket messages through a plain Worker are not billed as requests; no duration charge; CPU
  time is billed.
- Durable Objects: incoming WebSocket messages bill at 1/20 of a request; outgoing are free;
  WebSocket protocol pings are free and answered without waking the object; objects eligible for
  hibernation aren't billed for duration.
- An **outbound** WebSocket held by a Durable Object keeps it alive (not hibernatable), so all
  Worker↔DO sockets are opened **by Workers**.

## Topology

```
client A ──ws──▶ Worker (A's PoP) ══owner ws══▶ Mailbox[A] (created near A)
client B ──ws──▶ Worker (B's PoP) ══link ws═══▶ Mailbox[A]
path of a frame B→A: Worker(B) ─link→ Mailbox[A] ─owner→ Worker(A) → client A
```

- **Owner socket:** opened by the Worker holding a client connection of A, to `Mailbox[A]`, right
  after the upgrade. One per client connection.
- **Link socket:** opened by a Worker isolate that needs to send to A; shared by all connections
  in that isolate; idle-closed after 60 s.

## Worker (`src/worker.ts`)

### Routes

| Request | Handling |
| --- | --- |
| `GET /v1/connect` (upgrade) | Upgrade flow below |
| `/v1/ping`, `/v1/captive`, `/healthz`, `/robots.txt` | `core/http.ts`; never touches a DO |
| else | 404 |

### Upgrade flow

```ts
const decision = negotiateUpgrade(toUpgradeRequest(request), env());
if (!decision.ok) return new Response(decision.body, { status: decision.status, headers: decision.headers });
if (!(await policy.allow(decision.endpoint, decision.token))) return new Response("access denied", { status: 403 });

const [client, server] = Object.values(new WebSocketPair());
server.accept();
const conn = { host: "cf", id: ulid() };
const { state, effects } = openConnection({ conn, decision }, env());
local.set(connKey(conn), { ws: server, state, nonce: decision.nonce });
server.addEventListener("message", ev => onMessage(conn, ev));
server.addEventListener("close",   () => onClosed(conn));
server.addEventListener("error",   () => onClosed(conn));
run(conn, effects);                       // sends ServerInfo, opens the owner socket (register)
return new Response(null, { status: 101, webSocket: client,
  headers: { "Sec-WebSocket-Protocol": "switchback.v1" } });
```

`caps = { canPauseReads: false, serverPings: false, region: request.cf?.colo ?? "" }`.
Client WebSocket pings are answered by the platform; the Worker sees no message for them
(verify in M4 with a raw client; if the runtime surfaces pings to the Worker, answer in the
Worker, never forward to a DO).

### Isolate-local state

Module scope (all sockets accepted by an isolate are handled by it):

```ts
const local = new Map<string, { ws: WebSocket; state: ConnState; owner?: WebSocket; timer?: number; nonce: Uint8Array }>();
const activeByEndpoint = new Map<EndpointId, string>();   // connKey of locally-held ACTIVE conns (fast path)
const links = new LinkCache(env);
```

### Effects

| Effect | Worker action |
| --- | --- |
| `send` | `ws.send(bytes)`. No backpressure API: cap outbound data frames per conn at `cf.maxOutboundFramesPerSec` (default 2 000) and drop beyond. |
| `close` | `ws.close(code, reason)`; then `socketClosed`. |
| `timer` | `setTimeout` per conn. |
| `register` | Open the owner socket (below); step `registered` once it's open. |
| `unregister` | On the owner socket send text `{"t":"bye","sentTo":[...]}`, then close it (1000). |
| `route` | If `activeByEndpoint` has `dst` → step its conn with `deliver`. Else `links.send(dst, frame)`. |
| `metric` | Workers Analytics Engine (`env.METRICS.writeDataPoint`), sampled (doc 10). |

### Owner socket

```ts
const stub = env.MAILBOX.get(env.MAILBOX.idFromName(endpoint));
const res = await stub.fetch("https://mailbox/owner", { headers: {
  Upgrade: "websocket", "x-conn": connKey(conn), "x-nonce": b64(nonce), "x-nonce-ttl": String(2 * authSkewMs) } });
if (res.status === 409) return closeClient(conn, 1008, "auth replay");
const owner = res.webSocket!; owner.accept();
owner.addEventListener("message", ev => typeof ev.data === "string"
  ? step(conn, { kind: "registryNotice", notice: JSON.parse(ev.data).n })
  : step(conn, { kind: "deliver", frame: new Uint8Array(ev.data as ArrayBuffer) }));
owner.addEventListener("close", () => closeClient(conn, 1011, "mailbox lost"));
```

Keep `activeByEndpoint` in sync with `becameActive` / `becameInactive` / `promoted` / close.
If the owner socket drops (DO redeploy/eviction with open sockets is rare but possible), send
`Restarting(0, 10000)` and close the client with 1012; the client reconnects make-before-break.

### Link cache

- One link per destination per isolate; frames on a link are complete `Recv`/`RecvBatch` frames already
  carrying the sender's key. The mailbox forwards them verbatim.
- Open on demand: `stub.fetch("https://mailbox/link", { headers: { Upgrade: "websocket" } })`.
  While opening, queue ≤ 64 frames for ≤ 2 s; drop beyond.
- Close after `cf.linkIdleMs` (60 000) idle; cap `cf.maxLinksPerIsolate` (1 024), LRU.
- Abuse cap: each client connection may open at most `maxNewDestinationsPerMinute` (default 120)
  links to destinations not already open. Links create Durable Objects; this stops spraying.

## Mailbox Durable Object (`src/mailbox.ts`)

SQLite-backed class; **all** sockets accepted with the Hibernation API (`ctx.acceptWebSocket`).

### fetch routes

| Path | Caller | Behaviour |
| --- | --- | --- |
| `/owner` | Worker holding a client conn of this endpoint | Replay check, then accept with tag `owner`, attachment `{conn, role, deactivatedAt?}` |
| `/link` | any Worker sending here | Accept with tag `link` |

### Replay check

Nonces live in the mailbox's SQLite storage: table `nonces(nonce BLOB PRIMARY KEY, expires_ms INTEGER)`.
On `/owner`: delete expired rows; if the nonce exists → respond `409`; else insert and continue.
One row write per connection — cheap, and it naturally scopes the cache per EndpointId.

### Registry state

Keep the core `EndpointEntry` in memory, rebuilt after hibernation from socket attachments:
- active = owner socket with `role: "active"`; inactive stack ordered by `deactivatedAt`.
- Update attachments (`serializeAttachment`) whenever roles change.
- Persist `sentTo` in storage only when a `bye` arrives while other owners remain (rare); delete on
  full departure.

### Handlers

- **Owner accepted** → `registryStep(register)`; send notices as text `{"n":"becameActive"}` etc.
  The new owner gets `becameActive` before any data (same ordered socket).
- **Binary message on a link** → active owner exists ? `owner.send(frame)` : drop + metric.
- **Text `bye` on an owner** → remember its `sentTo` until the close.
- **Owner close/error** → `registryStep(unregister)`; `promoted` notice if any; on `gone`, send an
  `PeerGone(self)` frame to each `notifyEndpoints` mailbox via **DO RPC**
  (`env.MAILBOX.get(idFromName(e)).deliverControl(frame)`) inside `ctx.waitUntil`; ignore failures.
- **`deliverControl(frame)`** (RPC) → forward to the active owner if any.
- **Link close** → nothing.

### Hibernation hygiene

- Constructor: no storage reads. Lazy-load storage only for nonce checks and the rare `sentTo`.
- No `setTimeout`/`setInterval`, no alarms, no outbound sockets in the DO.

### Placement

A DO is created near its first caller and never moves. Owners usually register before anyone
sends to them, so mailboxes land near their endpoints. Roaming users keep a mailbox in their
original region (a detour per relayed frame); see doc 12 for the regional-mailbox idea.

## Conformance under Miniflare

`src/testing/cloudflareRouter.ts` implements the `Router` interface by opening owner/link sockets
through `@cloudflare/vitest-pool-workers`, so `packages/conformance` runs the router suite against
the mailbox.

## `wrangler.jsonc`

```jsonc
{
  "name": "cairn",
  "main": "src/worker.ts",
  "compatibility_date": "2026-10-01",
  "durable_objects": { "bindings": [{ "name": "MAILBOX", "class_name": "Mailbox" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Mailbox"] }],
  "routes": [{ "pattern": "cairn.example.net", "custom_domain": true }],
  "limits": { "cpu_ms": 300000 },
  "observability": { "enabled": true },
  "analytics_engine_datasets": [{ "binding": "METRICS", "dataset": "cairn" }],
  "vars": { "RELAY_CONFIG": "{}" }
}
```

Secrets: `ACCESS_TOKEN_PUBLIC_KEYS` (doc 10).

## Risks to measure in M4 (record results in `docs/decisions.md`)

1. Does Worker CPU time accumulate across a WebSocket's life (30 s default, 5 min max)? Hold a
   socket 24 h and relay 5 GB through it. If killed, confirm the client's reconnect hides it.
2. Do link sockets count against the 10 000 subrequests per invocation? Open 12 000 links from one
   client connection. If yes, recycle long-lived client connections with `Restarting` before the cap.
3. Are client WebSocket pings answered without invoking the Worker?
4. DO wake latency after hibernation (p50/p99 added per delivered frame).
5. Relay frames per connection-minute with the quiet-relay-path client patch, vs without.
