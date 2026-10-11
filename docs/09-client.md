# 09 — The Switchback client

The Switchback client is the endpoint stack apps embed. Its first release is
**`switchback-endpoint 1.0.0`, speaking `switchback.v1` only.** There are no earlier clients.

The client is a **complete from-scratch implementation** (ADR-010): no foreign peer-to-peer
stack's code, names or wire formats appear in this repository. Proven ideas from existing P2P
relay architectures — QUIC multipath, holepunching, relays addressed by key — are reimplemented
under our own crates. Reference source for study lives outside the repository and is never
imported.

## Layout

Client SDKs live under `clients/`, one directory per language (ADR-011). Rust is the reference
implementation today; TypeScript, Python and others slot in later.

```
clients/
  rust/
    switchback-proto/       Switchback v1 codec + auth blob; shares vectors with @cairn/core
    switchback-stun/        RFC 5389 Binding request/response (XOR-MAPPED-ADDRESS)
    switchback-endpoint/    the app-facing crate: config, builder, dialing helpers (v1.0.0)
```

The QUIC socket layer (connection setup, path management, holepunching, relay transport) lives
inside `switchback-endpoint` under `src/socket/`. The choice of QUIC protocol library it builds
on is recorded as its own ADR when M4 starts; the socket layer's own logic — path selection,
keepalive policy, relay fallback — is ours either way.

Apps depend only on `switchback-endpoint`, which defines and re-exports the types apps need
(`Endpoint`, `EndpointId`, `EndpointAddr`, `SecretKey`, connection types).

## Client work items

Each item is its own commit (C1…C7) with tests.

### C1 — Relay client speaking Switchback v1

- Connect to `<cairn-url>/v1/connect` with subprotocol `switchback.v1` and a fresh
  `Switchback-Auth` blob (doc 01 §3.2) built by `switchback-proto` from the endpoint's secret key,
  the host, the current time and a random nonce. Access token via
  `Authorization: Bearer` (`SwitchbackConfig::access_token`).
- Non-101 responses are connect errors carrying status and body (`401 auth: stale` etc.).
- Frames: send `Send`/`SendBatch`; receive `ServerInfo`, `Recv`, `RecvBatch`, `PeerGone`,
  `Status`, `Restarting`; **ignore unknown types and unknown status codes**.
- `PeerGone(A)` maps to the socket layer's "remote endpoint gone" handling for relay paths.

### C2 — WebSocket keepalive

- WebSocket **ping control frame** every 15 s; pong expected within 5 s; else reconnect.
- Measured on Cloudflare (ADR-016): control pings alone do not stop eyeball idle reaping;
  when no data has flowed for 30 s the client sends an empty datagram to itself
  (doc 01 §6). On Node (Cairn Pool) pings suffice — the self-keepalive is harmless there.

### C3 — Make-before-break reconnects

- `Restarting(reconnect_in, try_for)`: after a random delay in `[0, reconnect_in]`, open a new
  connection, keep the old one until the new one is up, then close the old one.
- `ServerInfo.max_conn_age_s > 0`: do the same at `age − random(30..120 s)`.
- `Status(1 Displaced)`: if we opened the newer connection, close this one quietly; otherwise log a
  warning (the key is in use elsewhere) and close.

### C4 — Quiet relay path once direct

- When a direct (IP) path becomes the selected path: stop keepalives on the relay path and mark
  it backup. The relay path idles out (~30 s) and stops costing relay messages.
- When the selected direct path is lost or degrades: re-open/re-validate a relay path and restore
  its keepalive while it is selected.
- Policy enum `RelayPathPolicy::{QuietWhenDirect (default), AlwaysWarm}`; calls/real-time apps may
  choose `AlwaysWarm`.
- Acceptance (`tools/e2e echo-direct`): relay frames for the connection reach zero within 35 s of
  the direct path being selected; failover after killing the direct path completes within the path
  idle timeout plus two round trips.

### C5 — STUN address discovery

- `switchback-stun`: RFC 5389 Binding Request **from the endpoint's own UDP socket(s)** to each
  configured STUN server (default `stun.cloudflare.com:3478`).
- Demultiplex in the IP receive path: packets from a configured STUN server whose payload has a
  STUN header (first two bits 0, magic cookie `0x2112A442` at bytes 4–7, known transaction id) go
  to the net report, never to QUIC.
- Feed `XOR-MAPPED-ADDRESS` into the report where reflexive addresses go; with two STUN servers,
  detect mapping-varies-by-destination.
- Run on start, on network change, every 5 minutes, and every 25 s while any connection lacks a
  direct path (keeps NAT mappings fresh).
- Acceptance: `tools/e2e stun` matches an external check; NAT-simulation direct-path success rate
  is recorded and meets the target set in M7.

### C6 — Cairn probes

- Captive-portal check: `GET http://<cairn-host>/v1/captive` with `Switchback-Challenge` (16–32
  random alphanumerics); captive unless `204` with the exact `Switchback-Response` echo.
- No relay-latency probing (one anycast Cairn URL; nothing to choose between).

### C7 — No foreign network defaults

- The client knows exactly one deployment URL (its Cairn) and the configured STUN servers.
  Nothing in the client references, resolves or falls back to any network other than the
  configured Cairn deployment. `SwitchbackConfig` has no preset concept; all defaults are
  constants in our crates.

## `switchback-endpoint` API (v1.0.0)

```rust
pub struct SwitchbackConfig {
    pub cairn_url: CairnUrl,                   // e.g. https://cairn.example.net
    pub stun_servers: Vec<String>,             // default ["stun.cloudflare.com:3478"]
    pub access_token: Option<String>,
    pub relay_path_policy: RelayPathPolicy,    // default QuietWhenDirect
}

/// Endpoint builder preconfigured for Switchback: Cairn as the only relay, STUN, quiet relay path,
/// CairnLookup (any EndpointId resolves to the Cairn URL), no other lookup services.
pub fn builder(cfg: &SwitchbackConfig) -> Builder;

/// Dial a peer by id alone.
pub fn addr(cfg: &SwitchbackConfig, peer: EndpointId) -> EndpointAddr;   // EndpointAddr::new(peer).with_cairn_url(cfg.cairn_url)

pub const PROTOCOL_VERSIONS: &[&str] = &["switchback.v1"];
```

`CairnLookup` implements the socket layer's `AddressLookup` trait: `publish` is a no-op;
`resolve(id)` yields one item containing only the Cairn URL, so `endpoint.connect(peer_id, alpn)`
needs no lookup traffic.

Test helper: `builder_relay_only(cfg)` (no IP transports) forces relayed connections for
`tools/e2e echo-relayed`.

## Browser / WASM (deferred)

Browsers can't set headers or send WebSocket pings. C1 sends auth as `?auth=`; browser keepalive
is deferred (doc 12). Not before M8.
