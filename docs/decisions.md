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

## ADR-016 — Cloudflare staging: measured platform behaviours (doc 04 risks 1–4) and the data-keepalive
**Context:** Doc 04 lists five risks to measure on real Cloudflare infrastructure. With
account credentials available, Cairn Edge staging was deployed
(`cairn-staging.veracity-agent.workers.dev`, workers.dev subdomain; a custom domain on
the `veracity.software` zone is possible later for port-80 `/v1/captive`).
**Measurements (2026-10-11, staging, us-region client):**
1. *Worker CPU accumulation on long-lived sockets*: a connection with a 20 s data
   exchange cycle **held 400 s with no kill** — no 30 s/5 min CPU ceiling was observed.
2. *Link sockets vs the 10k subrequest cap*: **12 000 distinct destinations from one
   client connection in 7.7 s; the invocation survived.** Link opens do not trip the
   cap (or are not counted as subrequests).
3. *Client pings without invoking the Worker*: 5/5 pings answered — confirmed the
   platform answers pings itself.
4. *DO wake latency*: warm frame RTTs 24–46 ms; first frame after >65 s hibernation
   **55.6 ms** (wake adds ~10–30 ms), second frame 21 ms.
5. *Quiet-relay frames*: not separately measured (superseded by finding below).
**Finding that changed the design:** Cloudflare **reaps eyeball WebSockets after ~1–2
minutes of data silence regardless of control pings** (ping-only client died ≈75 s in;
client sending data survived indefinitely). WS control pings do not count as activity.
**Decision:** (a) The client (C2) keeps its 15 s pings for liveness, and additionally
sends an **empty datagram to itself** whenever no data has flowed for 30 s (doc 01 §6
updated; self-sends are explicitly allowed and relayed as ordinary traffic). (b) Cached
links now idle-close at **45 s** (`cf.linkIdleMs`, below the measured reap): our own
close fires before the platform's silent reap, so the next send reopens the link instead
of vanishing into a dead socket. (c) The Worker pings owner sockets every 25 s where the
runtime exposes `ping()` on DO-fetch sockets. (d) Doc 04's risk list is updated with
these numbers; staging deploys use `workers_dev` (envs don't inherit
`durable_objects`/`analytics_engine_datasets` — they are declared per env).
**Consequences:** Quiet connections now cost ≤2 self-keepalive frames/minute on
Cloudflare (billed 1/20-request each) instead of the old iroh-style 5 s keepalives
(12/min) — still a ~60× improvement, and zero on Cairn Pool. M7's `echo-direct`
acceptance (relay frames → 0 within 35 s of going direct) must account for the
self-keepalive cadence: expect ≤1 keepalive frame per 30 s quiet interval, not zero.

## ADR-017 — Redis router details: envelope kind 3, Router.ready, single-node cluster tests
**Context:** M6 needed three small decisions beyond docs/06 while building
`router-redis`. (a) The registry cap can evict an inactive connection owned by a
*different* host, so `close` actions must be deliverable cross-host; docs/06 defined
only deliver/notice envelope kinds. (b) A host must not accept traffic before its
pub/sub subscription is live, or the first frames published to it vanish (the
cross-instance flavor of the doc 06 registering race). (c) Differential/cluster tests
need a cluster in Testcontainers.
**Decision:** (a) Envelope gains kind 3 (`close`, u16 code) — docs/06 updated. (b)
`Router` gains optional `readonly ready?: Promise<void>` (docs/03); `RedisRouter.ready`
resolves after subscribe + host-key set, and `adapter-node` awaits it before listening.
(c) Cluster conformance uses a single-node cluster (`bitnamilegacy/redis-cluster:7.2.4`,
fixed host port 17000) bootstrapped with `set-config-epoch` + `cluster addslots` for all
16384 slots; state flips to `ok` after the cluster-node-timeout (~15s).
**Consequences:** Lua and `core.registryStep` are pinned to each other by a differential
property test (10k+ random ops, state compared after every op). Provider staging
deploys (AWS/GCP/Azure) are built (`deploy/aws|gcp|azure`, `tofu validate` clean) but
NOT applied: no cloud credentials in the environment; the docker-compose pool is the
deployable proof (image 258 MB, e2e `smoke` on node 1, all scenarios on node 2).

## ADR-018 — Hyperscaler pools deferred; M7 scope decisions
**Context:** (a) M6's provider staging deploys need AWS/GCP/Azure credentials that are not
available; the user chose to leave them incomplete rather than chase credentials.
(b) M7 (C4/C5) needs design commitments for our from-scratch client: how peers learn
each other's UDP addresses, and how the quiet-relay acceptance interacts with the
ADR-016 self-keepalive.
**Decision:** (a) AWS/GCP/Azure remain UNVERIFIED end-to-end: Terraform validates
(`tofu validate`), the image builds and passes e2e via the docker-compose pool, but no
provider deployment exists. `docs/11-milestones.md` M6 carries a status block listing
exactly what remains. (b) Direct-path discovery in v1 is **in-band**: after the QUIC
handshake completes over the relay, the peers exchange UDP candidates (local socket
address + STUN reflexive address) on a dedicated bi stream with ALPN
`switchback/candidates`, then switch the hybrid socket to direct mode. (c) With
`QuietWhenDirect` (default), the client suppresses relay self-keepalives (ADR-016)
once the direct path is selected and instead keeps the NAT mapping open with a 15s
QUIC keepalive on the direct path — so "relay frames reach zero" is literal. The
e2e `echo-direct` window starts when both directions confirm direct mode.
**Consequences:** M7's NAT-simulation STUN-vs-baseline comparison is moot in the form
doc 08 wrote it (our client never had QAD; STUN is the only discovery mechanism) —
NAT-lab success-rate numbers still require the network-namespace topology and are
deferred with the job skeleton. Cloud Run hourly-recycling verification needs a GCP
deployment (deferred with the providers). Holepunching across arbitrary NATs (the hard
part of "direct") is NOT in v1 scope beyond STUN reflexive + LAN/loopback candidates;
multi-NAT support is future work (docs/12).

## Open questions (resolve during the milestones; record outcomes as new ADRs)

- M4/M5: Are client WebSocket pings answered by the Workers runtime without invoking the Worker?
- M5: Worker CPU accumulation and subrequest limits on long-lived sockets (doc 04 risks 1–2).
- M6: Container Apps ingress idle timeout and maximum WebSocket duration.
- M7: STUN vs relay-based address discovery direct-path success rates in NAT simulation.
- M8: Autoscaling targets (connections per instance) per platform.
