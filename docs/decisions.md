# Architecture decision records

Format: context → decision → consequences. Add new records at the end; never rewrite accepted
ones — supersede them.

## ADR-001 — TypeScript core, functional core / imperative shell
**Context:** The relay must run on Cloudflare Workers (JS/WASM) and in containers.
**Decision:** One pure TypeScript package holds all protocol and routing rules; adapters do I/O.
**Consequences:** One implementation of the rules, testable with a fake clock. A Rust client
shares the protocol through vectors, not code.

## ADR-002 — Cloudflare: edge-terminated sockets, Durable Objects only route
**Context:** Durable Object incoming messages are billed per message; plain-Worker WebSocket
messages aren't; DOs holding outbound sockets can't hibernate.
**Decision:** Client sockets end in Workers; one Mailbox DO per EndpointId; all Worker↔DO sockets
are opened by Workers; pings never reach a DO.
**Consequences:** About 16× cheaper per relayed frame than DO-terminated sockets in our model.
Open risks: Worker CPU accumulation on long sockets, subrequest limits (doc 04).
Mailboxes are placed near their first caller and never move.

## ADR-003 — Container pools on hyperscalers, no managed WebSocket gateways
**Context:** AWS API Gateway WebSockets reject binary client frames and cap connections at 2 h;
Azure Web PubSub adds an HTTP hop per frame and a fixed URL path.
**Decision:** On AWS, GCP and Azure run `adapter-node` containers with a Redis/Valkey router.
**Consequences:** One container adapter for all three; we operate Redis and autoscaling.

## ADR-004 — STUN instead of QUIC address discovery
**Context:** Workers can't receive UDP; QAD would need our own UDP servers.
**Decision:** Clients use `stun.cloudflare.com:3478` (free, unlimited, anycast) from their own UDP
sockets (fork change S5). No deployment runs UDP services.
**Consequences:** STUN is unauthenticated: an on-path attacker can feed wrong addresses, causing a
failed holepunch and a relayed connection, not impersonation. Networks blocking UDP 3478 lose
reflexive addresses.

## ADR-005 — No discovery service in v1
**Context:** Every endpoint uses the same relay URL; the relay's registry already knows who is online.
**Decision:** Dial with `EndpointAddr::new(id).with_cairn_url(url)` / `CairnLookup`. No record publishing, no DNS lookups.
**Consequences:** Zero lookup latency and cost. All endpoints must share one deployment (doc 12: federation later).

## ADR-006 — Redis/Valkey pub/sub for cross-instance delivery
**Context:** Cloud Run instances aren't individually addressable; a portable mechanism is needed.
**Decision:** Presence in Redis hashes with Lua for atomic registry ops; delivery via per-host
channels (sharded pub/sub in cluster mode).
**Consequences:** One PUBLISH per cross-instance frame; per-pair order best-effort. A direct mesh
can replace it later behind the same interface.

## ADR-007 — (redacted) Client previously planned as a patch of a foreign P2P stack
**Status: superseded by ADR-010.**
**Context:** The original plan built the client as a patch set on top of a third-party
peer-to-peer stack kept in-tree.
**Decision:** Rejected. Per the repository hygiene rule (no foreign P2P stack may be referenced
in this repository), the full text of this ADR was removed when ADR-010 was accepted.
**Consequences:** See ADR-010.

## ADR-008 — Switchback v1 is the first version; no compatibility
**Context:** This is a new network. No earlier clients exist, and it never interoperates with
any foreign network or anything else.
**Decision:** The first protocol is `switchback.v1`; the first client is `switchback-endpoint
1.0.0`. Cairn accepts only `switchback.v1` and rejects anything else with `400`. No fallback,
downgrade or legacy code anywhere. Frame types are a clean `0x01`–`0x08` set. Compatible additions
within v1 are limited to new relay→client frame types, new status codes and trailing ServerInfo
fields; everything else needs `switchback.v2`.
**Consequences:** Less code and a cleaner spec. When v2 arrives, whether Cairn keeps serving v1 is
a separate, explicit decision.

## ADR-009 — Names
**Decision:** Protocol and client stack: **Switchback**. Relay/discovery infrastructure: **Cairn**
(Cairn Edge on Cloudflare, Cairn Pool on containers). Wire token `switchback.v1`, headers
`Switchback-Auth` / `Switchback-Challenge` / `Switchback-Response`, crates `switchback-*`, npm
scope `@cairn/*`.
**Consequences:** Before public launch, check trademarks, npm/crates.io names and domains; renaming
later is a find-and-replace in docs and code, plus a new auth context string (which is a wire
change, so it should happen before v1 ships).

## ADR-010 — No foreign P2P stack in the repository; client built from scratch
**Context:** The protocol and the stack on top of it are a complete replacement for existing
systems. The repository must not contain a single reference to any foreign peer-to-peer project —
no fork, no submodule, no dependency, no mention in specs, code or commit messages. Foreign
source may be consulted for ideas only, kept outside the repository (e.g. a scratch clone in
`/tmp`).
**Decision:** The client is implemented from scratch in `clients/rust/` (doc 09, work items
C1–C7). ADR-007 is superseded. Docs and milestones were re-scoped accordingly in the same
commit.
**Consequences:** We own all client code, including the QUIC socket layer — larger M4/M7 scope
than patching a fork, but no rebase burden and no license/attribution entanglement. The choice of
QUIC protocol library under `switchback-endpoint` is recorded as its own ADR when M4 starts.

## ADR-011 — Multi-language client SDK layout; mise-managed toolchains
**Context:** Client SDKs for other languages (TypeScript, Python, …) are expected after the Rust
reference implementation, and all developers should run identical Node and Rust toolchains.
**Decision:** Client SDKs live under `clients/<language>/` (`clients/rust/` today; future
directories slot in beside it). All development tools are pinned with mise in `.mise.toml`
(Node.js, pnpm, Rust); `rust-toolchain.toml` mirrors the Rust pin so bare `cargo` invocations
agree. The Cargo workspace covers `clients/rust/*` and `tools/*`.
**Consequences:** Adding a language = adding a directory + its own package-manager workspace +
its mise pins. CI installs tools via mise, so local and CI toolchains cannot drift.

## ADR-012 — Router-initiated closes; over-budget frames; nonce cache capacity
**Context:** Three details are underspecified by docs/01–03. (a) The registry can evict a
connection (1008, doc 01 §5.1) or otherwise need a connection closed, but doc 03's
`SocketHost` interface gave the Router no way to close a socket. (b) Doc 02 says an
over-budget frame causes `pauseReads` on Node but "drop + metric" on Workers; it does not
say whether the Node frame itself is dropped. (c) The replay cache bound is a new number.
**Decision:** (a) `SocketHost` gains `close(conn, code, reason)` (docs/03 updated).
(b) The over-budget frame is dropped on every host (`rate_limited` metric); Node-class
hosts additionally get `pauseReads` (emitted once until `underQuota`) so the read stream
backs up instead of repeatedly dropping — datagram loss is protocol-acceptable (doc 01
relays QUIC datagrams). `Status(2 RateLimited)` at most once per connection. (c)
`nonceCacheCapacity` config key, default 100 000 per host (docs/10 updated).
**Consequences:** The Redis Lua scripts must reproduce the same registry rules including
re-register semantics (a re-register of the active conn is a no-op; of an inactive conn it
is promoted through the normal newest-wins path).

## ADR-013 — QUIC protocol library: quinn
**Context:** The client is a from-scratch implementation (ADR-010). We need a production QUIC
stack (handshake, streams, congestion control, path management) but not our own protocol
wire format: the Switchback v1 wire is relay frames + our endpoint identity layer, which we
own. Writing a QUIC implementation is years of work and explicitly out of scope.
**Decision:** `switchback-endpoint` builds on [`quinn`](https://docs.rs/quinn) 1.x as its
QUIC protocol engine. Cairn relay paths are realised by implementing quinn's
`AsyncUdpSocket` trait over the Switchback v1 relay client (Send/Recv frames in place of
UDP datagrams); each peer EndpointId maps to a deterministic reserved IPv4 address
(240.0.0.0/4) so quinn's connection model works unchanged. Endpoint identity is Ed25519
(doc 01): each endpoint's TLS certificate carries an extension
`endpoint_id || ed25519_sign(tls_spki || endpoint_id)`, verified by both sides on connect.
Alternatives considered: s2n-quic (heavier, smaller ecosystem), quiche (C++ build),
custom QUIC (rejected: out of scope).
**Consequences:** QUIC wire internals (crypto, ACKs, congestion) are quinn's; everything the
relay sees (frames, addressing, identity proofs) is Switchback v1 and testable via the
shared vectors. Future IP/holepunching paths (M7) plug additional `AsyncUdpSocket`s into
the same endpoint.

## ADR-015 — Cloudflare: no cross-request WebSocket sends; ready handshake; owner-open retry
**Context:** Docs/04 designed an isolate-local fast path (Worker(A) delivers directly to
a socket held by Worker(B)) and assumed the Hibernation API could be validated under
Miniflare. Both assumptions failed against the real platform during M5: (a) current
Cloudflare Workers reject sending on a WebSocket owned by a different upgrade request
("Cannot perform I/O on behalf of a different request") — even the canonical chat
pattern fails; (b) socket events do not buffer for late listeners, so notices sent
between a mailbox's 101 and the Worker's listener attachment were dropped; (c) DO
websocket fetches can transiently fail with "Network connection lost" while a mailbox
evicts; (d) the local `@cloudflare/vitest-plugin` runtime (Miniflare 5 alpha) silently
drops cross-instance socket sends and mangles some binary deliveries, so the push-heavy
router semantics can't run there.
**Decision:** (a) Every relayed frame travels the documented link path: Worker →
destination mailbox → owner socket → owning Worker (doc 04 updated). This keeps exactly
one billed DO message per frame; the fast-path optimization is unavailable on current
Workers and may be revisited when the platform allows it. (b) Owner sockets use a
`{"t":"ready"}` handshake: the mailbox buffers notices/frames per owner until `ready`,
then flushes in order. (c) Owner-socket opens retry up to 3 times with backoff; a 409
replay verdict is final (doc 01 §3.1: close 1008 after accept). (d) Conformance for the
mailbox runs against `wrangler dev` (real workerd): host suite 13/13 and e2e
probes/echo-relayed/displace/gone/replay/stale all pass; the Miniflare suite keeps the
nonce-replay unit test and the pull-based semantics that the local runtime proves
reliably. (e) The Mailbox uses the Hibernation API (`acceptWebSocket` + attachments +
`getWebSockets()`), keeping registry state in attachments so it survives eviction.
**Consequences:** Same-PoP pairs pay one DO message per frame where the old model hoped
for zero; revisit when the platform lifts the cross-request I/O restriction (measure on
staging). The `activeByEndpoint` map remains for metrics/future use. Binary WebSocket
payloads may arrive as `Blob` or `ArrayBufferView` depending on the runtime: adapters
must normalise (`toBytes`).

## Open questions (resolve during the milestones; record outcomes as new ADRs)

- M4/M5: Are client WebSocket pings answered by the Workers runtime without invoking the Worker?
- M5: Worker CPU accumulation and subrequest limits on long-lived sockets (doc 04 risks 1–2).
- M6: Container Apps ingress idle timeout and maximum WebSocket duration.
- M7: STUN vs relay-based address discovery direct-path success rates in NAT simulation.
- M8: Autoscaling targets (connections per instance) per platform.
