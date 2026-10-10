# 03 — Ports: `SocketHost` and `Router`

Two interfaces separate the core from platforms. `packages/conformance` holds the tests every
implementation must pass (doc 08).

## SocketHost

Owns client WebSockets and drives the core for each.

### Responsibilities

1. Serve the HTTP surface (doc 01 §2) via `core/http.ts`.
2. Upgrade flow: `negotiateUpgrade` → `router.claimNonce` (except Cloudflare, doc 04) → access
   policy → accept the WebSocket with `Sec-WebSocket-Protocol: switchback.v1` → assign a `ConnRef`
   → `openConnection` → execute effects.
3. Inbound binary message → `step(frame)`; text → `textMessage`; close/error → `socketClosed`.
4. Execute effects:

| Effect | SocketHost action |
| --- | --- |
| `send` | Write a binary message. Enforce doc 01 §5.2 queue caps (512 data / 64 control); drop beyond. |
| `close` | Close with the code, then step `socketClosed` once. |
| `timer` | One timer per connection, replaced each time; on fire step `timer`. |
| `register` | `await router.register(endpoint, conn)` → step `registered`. Notices arrive via `notify`. |
| `unregister` | `router.unregister(endpoint, conn, sentTo)`. |
| `route` | Local fast path if possible, else `router.route(dst, frame)`. Never block the read loop on it. |
| `pauseReads` / `resumeReads` | Apply backpressure where supported. |
| `metric` | Forward to the metrics sink (doc 10). |

5. Accept `deliver` / `notify` calls from the Router for local connections and step them.
6. On planned shutdown, step `drain` for every connection, staggered (doc 10).

```ts
export interface SocketHost {
  readonly hostId: string;          // goes into ConnRef.host
  readonly caps: Capabilities;
  deliver(conn: ConnRef, frame: Uint8Array): void;                  // unknown/closed conn: ignore + count
  notify(conn: ConnRef, notice: "becameActive" | "becameInactive" | "promoted"): void;
  close(conn: ConnRef, code: number, reason: string): void;          // router-initiated closes (e.g. eviction, 1008)
}
```

### Ordering rules

- Effects of one `step()` run in order. Steps for one connection are serialized.
- Writes to one socket keep effect order within each priority.
- Between `register` being issued and `router.register()` resolving, buffer `deliver`/`notify`
  for that connection (≤ 64 frames) and apply them after it resolves, notices first.

## Router

Maps EndpointIds to connections across the deployment and moves frames between SocketHosts.

```ts
export type Notice = "becameActive" | "becameInactive" | "promoted";

export interface Router {
  /** Newest wins. Resolves once the registration is visible to route() from anywhere. */
  register(endpoint: EndpointId, conn: ConnRef): Promise<void>;

  /** Remove conn; promote or, if fully gone, deliver PeerGone to the sent-to union. Unknown conn: no-op. */
  unregister(endpoint: EndpointId, conn: ConnRef, sentTo: EndpointId[]): Promise<void>;

  /** Deliver a ready relay→client frame to dst's active connection. Never waits for the remote write. */
  route(dst: EndpointId, frame: Uint8Array): Promise<"delivered" | "offline">;

  /** Record (endpoint, nonce) for ttlMs. Returns false if it was already recorded (replay). */
  claimNonce(endpoint: EndpointId, nonce: Uint8Array, ttlMs: number): Promise<boolean>;

  /** If dst's active connection is held by this process, return it (local fast path). */
  localActive(dst: EndpointId): ConnRef | undefined;

  close(): Promise<void>;
}
```

### Semantics (tested by `conformance/router.spec.ts`)

1. **Single active:** at most one connection per EndpointId receives routed frames at any time.
2. **Newest wins:** after `register(E, c2)` resolves, frames for `E` reach `c2`; `c1` got
   `becameInactive`, `c2` got `becameActive`.
3. **Notice before data** for the newly active connection.
4. **Promotion** of the most recently deactivated connection when the active one leaves; it gets
   `promoted`.
5. **Gone exactly once** per full departure, to each online member of the sent-to union.
6. **Offline drop:** no buffering for later (unless the optional reconnect buffer is on).
7. **Per-pair order** preserved (required: memory, Cloudflare; best-effort: Redis).
8. **Liveness cleanup:** registrations of a dead host disappear within `presenceTtlMs` (Redis).
9. **Replay:** `claimNonce` returns false for a repeated `(endpoint, nonce)` within the TTL, across
   all hosts of the deployment.

### Optional reconnect buffer

Hold up to 64 frames for an endpoint that went fully offline less than `reconnectBufferMs` ago
(default 0 = off; suggested 2 000) and flush them when it re-registers. With make-before-break
reconnects (doc 01 §4.6) this is rarely needed; leave it off unless measurements say otherwise.

## Implementations

| Package | Role | Where |
| --- | --- | --- |
| `router-memory` | Router: in-process maps + `core.registryStep` + `NonceCache` | single process, tests |
| `router-redis` | Router: Redis/Valkey presence, pub/sub, Lua (doc 06) | container pools |
| `adapter-node` | SocketHost (`ws`); uses memory or Redis router | containers, VMs |
| `adapter-cloudflare` | SocketHost (Worker) + Router semantics in the Mailbox DO (doc 04) | Cloudflare |

On Cloudflare the Router is realised by Worker→Durable Object sockets; the adapter also exposes an
object implementing `Router` for the conformance suite under Miniflare.
