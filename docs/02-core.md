# 02 — `packages/core`

A **pure** TypeScript library holding every rule of `docs/01-protocol.md`. Given state and
an event it returns new state plus effects. Adapters (doc 04, 05) feed events and execute effects.

No I/O, no timers, no `Date.now()`, no `crypto.getRandomValues()` inside the core: time and
randomness arrive through `Env`.

## Module map

```
packages/core/src/
  keys.ts          EndpointId bytes <-> z-base-32; point validation; small-order check
  crypto.ts        ed25519VerifyStrict, blake3DeriveKey (wrappers over @noble/*)
  auth.ts          auth blob encode/decode/verify (doc 01 §3.2); NonceCache (LRU, for memory deployments)
  tokens.ts        access-token verification (doc 10), pure
  upgrade.ts       negotiateUpgrade(): HTTP validation + auth → accept/reject decision
  frames.ts        encode/decode for the eight v1 frame types; forwardTransform()
  http.ts          responses for /v1/ping, /v1/captive, /healthz, /robots.txt, 404
  connection.ts    per-connection state machine: openConnection(), step()
  registry.ts      per-EndpointId reducer: newest-wins, promotion, PeerGone fan-out
  limits.ts        token bucket, bounded LRU set, rate counters
  config.ts        RelayConfig type, defaults, validation
  index.ts
```

## Identities

```ts
export type EndpointId = string;          // z-base-32 of the 32-byte key (canonical text form)
export interface ConnRef { host: string; id: string }   // opaque; chosen by the SocketHost
export const connKey = (c: ConnRef) => `${c.host}|${c.id}`;
```

z-base-32 alphabet: `ybndrfg8ejkmcpqxot1uwisza345h769`.

## Env

```ts
export interface Env {
  nowMs: number;                       // wall-clock ms (auth freshness needs real time)
  random(n: number): Uint8Array;       // CSPRNG
  config: RelayConfig;                 // doc 10
  caps: Capabilities;
}
export interface Capabilities {
  maxConnectionMs?: number;   // platform cut-off (Cloud Run: 3_600_000). Core closes before it.
  canPauseReads: boolean;     // Node: true; Workers: false (drop instead of pausing)
  serverPings: boolean;       // Node: true (ws ping/pong); Workers: false
  region: string;             // for ServerInfo
}
```

## Upgrade (`upgrade.ts`)

```ts
export interface UpgradeRequest {
  method: string; path: string;
  headers: Record<string, string>;      // lower-case names
  query: Record<string, string>;
}
export type UpgradeDecision =
  | { ok: true; endpoint: EndpointId; endpointBytes: Uint8Array; nonce: Uint8Array;
      subprotocol: "switchback.v1"; token?: string }
  | { ok: false; status: 400 | 401 | 404 | 426; headers: Record<string, string>; body: string };

export function negotiateUpgrade(req: UpgradeRequest, env: Env): UpgradeDecision;
```

Implements doc 01 §3.1 steps 1–4 (HTTP checks, version, auth freshness, key and signature). It
does **not** check the replay cache, the access policy or draining; adapters do those next (they
may be async):

```
decision = negotiateUpgrade(req, env)
if !decision.ok → respond decision
if !(await router.claimNonce(decision.endpoint, decision.nonce, 2*authSkewMs)) → 401 "auth: replay"
   (Cloudflare: deferred into the mailbox, doc 04)
if !(await policy.allow(decision.endpoint, decision.token)) → 403
accept WebSocket with subprotocol → openConnection(...)
```

## Connection state machine (`connection.ts`)

```ts
export interface ConnState {
  conn: ConnRef;
  endpoint: EndpointId;
  endpointBytes: Uint8Array;
  phase: "registering" | "open" | "closed";
  active: boolean;                         // set by registry notices
  openedAtMs: number;
  closeAtMs?: number;                      // from caps.maxConnectionMs or config.maxConnectionAgeMs
  rateLimitNotified: boolean;
  bucket?: TokenBucket;
  newDestinations: RateCounter;            // abuse cap, doc 10
  sentTo: BoundedSet<EndpointId>;
}

export function openConnection(args: { conn: ConnRef; decision: Extract<UpgradeDecision,{ok:true}> },
                               env: Env): { state: ConnState; effects: Effect[] };
export function step(state: ConnState, ev: Event, env: Env): { state: ConnState; effects: Effect[] };
```

`openConnection` emits, in order: `send(ServerInfo)`, `register(endpoint)`, and `timer(closeAtMs)`
if a max age applies. `closeAtMs = openedAt + maxAge − jitter` with jitter uniform in 30–120 s
(from `env.random`), so reconnect waves spread out.

### Events

```ts
export type Event =
  | { kind: "frame"; bytes: Uint8Array }                  // binary message from the client
  | { kind: "textMessage" }
  | { kind: "registered" }                                 // router.register resolved
  | { kind: "registryNotice"; notice: "becameActive" | "becameInactive" | "promoted" }
  | { kind: "deliver"; frame: Uint8Array }                 // ready relay→client frame (Recv, RecvBatch, PeerGone)
  | { kind: "socketClosed" }
  | { kind: "timer" }
  | { kind: "drain"; reconnectInMs: number; tryForMs: number }
  | { kind: "overQuota" } | { kind: "underQuota" };        // rate-limit signals from the host (optional)
```

### Effects

```ts
export type Effect =
  | { kind: "send"; bytes: Uint8Array; priority: "data" | "control" }
  | { kind: "close"; code: number; reason: string }
  | { kind: "timer"; atMs: number }                         // replaces the previous timer
  | { kind: "register"; endpoint: EndpointId }
  | { kind: "unregister"; endpoint: EndpointId; sentTo: EndpointId[] }
  | { kind: "route"; dst: EndpointId; frame: Uint8Array }   // frame already Recv/RecvBatch
  | { kind: "pauseReads" } | { kind: "resumeReads" }
  | { kind: "metric"; name: string; value?: number; labels?: Record<string, string> };
```

### Rules

- `frame` (any phase except closed):
  - `Send`/`SendBatch` → validate (doc 01 §4.2) → rate checks (token bucket; new-destination cap) →
    `forwardTransform` with `src = endpointBytes` → `route(dst, frame)` → add `dst` to `sentTo`.
    Over the byte budget: if `caps.canPauseReads` emit `pauseReads`, else drop + metric; send
    `Status(2 RateLimited)` once.
  - any other type, or decode failure → `close(1002)`; size violations → `close(1009)`.
- `registered` → phase `open`.
- `registryNotice`:
  - `becameActive` → `active = true`.
  - `becameInactive` → `active = false`; `send(Status(1 Displaced), control)`.
  - `promoted` → `active = true`; `send(Status(0 Active), control)`.
- `deliver` → if `active`: `send(frame, data)`; else drop + metric.
- `timer` at/after `closeAtMs` → `send(Restarting(0, 10_000))`, `close(1012, "max connection age")`.
- `drain` → `send(Restarting(reconnectInMs, tryForMs))`, `close(1012, "drain")`.
- `socketClosed` → `unregister(endpoint, [...sentTo])`, phase `closed`. Idempotent.
- `textMessage` → metric only.

## Registry reducer (`registry.ts`)

Every Router must implement exactly these rules. The memory router and the Cloudflare mailbox call
this reducer; the Redis router reimplements it in Lua and is differential-tested against it.

```ts
export interface EndpointEntry {
  active?: ConnRef;
  inactive: ConnRef[];                 // stack; most recently deactivated last
  sentTo: EndpointId[];                // union reported by closing connections (bounded)
}
export type RegistryOp =
  | { op: "register"; conn: ConnRef }
  | { op: "unregister"; conn: ConnRef; sentTo: EndpointId[] };
export type RegistryOut =
  | { notify: ConnRef; notice: "becameActive" | "becameInactive" | "promoted" }
  | { gone: { endpoint: EndpointId; notifyEndpoints: EndpointId[] } }
  | { deleteEntry: true };
export function registryStep(endpoint: EndpointId, entry: EndpointEntry | undefined, op: RegistryOp):
  { entry: EndpointEntry | undefined; out: RegistryOut[] };
```

- `register(c)`: if an active exists → push it to `inactive`, out `becameInactive` for it; set
  `active = c`; out `becameActive` for `c`. (Notices for `c` must reach it before any routed data.)
  If active + inactive now exceed `maxConnectionsPerEndpoint` (default 4), remove the **oldest**
  inactive connection and out `{ close: conn, code: 1008 }` for it (add this variant to `RegistryOut`).
- `unregister(c, sentTo)`: merge `sentTo` (bounded).
  - `c` is active: inactive non-empty → pop last, make active, out `promoted`; else out `gone`
    (with the merged set) + `deleteEntry`.
  - `c` is inactive → remove it.
  - unknown → no-op.

The router turns `gone` into one `PeerGone(endpoint)` frame (type 8) per online member of
`notifyEndpoints`.

## Frames (`frames.ts`)

```ts
export type ClientFrame =
  | { type: "send"; dst: Uint8Array; ecn: 0 | 1 | 2 | 3; datagram: Uint8Array }
  | { type: "sendBatch"; dst: Uint8Array; ecn: 0 | 1 | 2 | 3; segmentSize: number; datagrams: Uint8Array };
export function decodeClientFrame(bytes: Uint8Array): ClientFrame | FrameError;
export function forwardTransform(bytes: Uint8Array, src: Uint8Array): Uint8Array | FrameError;
export const encode: { serverInfo, recv, recvBatch, peerGone, status, restarting };
export const FrameType = { ServerInfo: 0x01, Send: 0x02, SendBatch: 0x03, Recv: 0x04, RecvBatch: 0x05,
  PeerGone: 0x06, Status: 0x07, Restarting: 0x08 } as const;
export function decodeRelayFrame(bytes: Uint8Array): RelayFrame | FrameError;   // tests, tools
```

`forwardTransform` allocates the output once and copies `contents` once.

## Errors → close codes

As doc 01 §8. Adapters map unexpected exceptions to 1011.

## Required tests (details in doc 08)

- z-base-32 round trips.
- Every frame and the auth blob against the shared vectors.
- Auth: valid; stale both directions; wrong host; bad signature; non-canonical S; small-order key;
  malformed lengths.
- `forwardTransform` cases from doc 01 §10.
- Registry property tests: random op sequences never yield two active connections, never lose an
  open connection, emit `gone` exactly once per full departure, and order notices before data.
- Connection SM with a fake clock: max-age close with jitter bounds, drain, rate-limit status sent
  once, inactive drops deliveries, text messages ignored.
