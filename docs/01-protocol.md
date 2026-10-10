# 01 — Switchback protocol v1 (normative)

**Switchback** is the wire protocol between endpoints and a **Cairn** relay. This document defines
**version 1**, the first version. There are no earlier versions, no earlier clients, and nothing
to stay compatible with. A server accepts only the versions it implements; today that is v1 only.

Byte order is **big-endian**. Lengths are exact unless stated.

---

## 1. Versioning rules

- The protocol version is carried in the WebSocket subprotocol token: `switchback.v1`.
- A server **rejects** any upgrade that doesn't offer a version it implements. There is no
  fallback, no downgrade and no legacy path.
- Clients declare the versions they speak. The first client release, `switchback-endpoint 1.0.0`,
  speaks `switchback.v1` only.
- A future incompatible change gets a new token (`switchback.v2`). Whether a deployment keeps
  serving v1 alongside v2 is decided at that time and recorded as an ADR.
- Compatible additions inside v1 are limited to: new **relay→client** frame types (clients ignore
  unknown types), new `Status` codes (clients ignore unknown codes), and trailing fields on
  `ServerInfo` (clients ignore trailing bytes). Anything else needs a new version.

---

## 2. HTTP surface

One hostname per deployment, e.g. `cairn.example.net`. HTTPS on 443; plain HTTP on 80 serves only
`/v1/captive`.

| Method + path | Port | Response |
| --- | --- | --- |
| `GET /v1/connect` + WebSocket upgrade | 443 (80 allowed in dev) | `101` + protocol (sections 3–6) |
| `GET /v1/ping` | 443 | `204`, empty body, `Cache-Control: no-store`, `Access-Control-Allow-Origin: *` |
| `GET /v1/captive` | **80, plain HTTP** | `204`; challenge echo (2.1) |
| `GET /healthz` | 443 | `200`, `application/json`, `{"status":"ok","version":"<semver>","commit":"<sha>","protocols":["switchback.v1"]}` |
| `GET /robots.txt` | 443 | `200`, `User-agent: *\nDisallow: /\n` |
| anything else | any | `404` |

### 2.1 `/v1/captive` (captive-portal detection)

Client: `GET http://<host>/v1/captive` with header `Switchback-Challenge: <token>` where `<token>`
is 16–32 random chars from `[A-Za-z0-9]`. Redirects are not followed.

Server: if the header is present and matches `^[A-Za-z0-9]{16,32}$`, respond with
`Switchback-Response: <token>`. Always status `204`, empty body.

The client concludes "captive portal" unless it receives `204` **and** the exact echo. Deployments
must serve this path on port 80 without an HTTPS redirect (doc 07).

### 2.2 `/v1/ping`

Used for liveness checks and diagnostics. Fast path only: no auth, no storage, no routing layer.

---

## 3. Connect (WebSocket upgrade)

```
GET /v1/connect HTTP/1.1
Host: cairn.example.net
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Version: 13
Sec-WebSocket-Key: <...>
Sec-WebSocket-Protocol: switchback.v1
Switchback-Auth: <base64url-nopad(auth blob)>        # browsers: query ?auth=<same>
Authorization: Bearer <access token>                 # optional; browsers: query ?token=<same>
```

### 3.1 Server validation order

1. `GET /v1/connect`, `Upgrade: websocket` (case-insensitive), `Sec-WebSocket-Key` present → else `400`.
2. `Sec-WebSocket-Version: 13` → else `426` with `Sec-WebSocket-Version: 13`.
3. `Sec-WebSocket-Protocol` contains `switchback.v1` → else `400` body
   `unsupported protocol version; supported: switchback.v1`.
4. Auth blob valid (3.2) → else `401` body `auth: <reason>` (`missing`, `malformed`, `stale`,
   `bad-key`, `bad-signature`, `replay`).
5. Access policy allows `(endpoint, token)` (doc 10) → else `403` body `access denied`.
6. Not draining → else `503` with `Retry-After: 1`.
7. `101 Switching Protocols` with `Sec-WebSocket-Protocol: switchback.v1`.

Every rejection happens before the WebSocket is accepted, except replay detection on Cloudflare,
which closes the socket with 1008 right after acceptance (doc 04).

### 3.2 Auth blob

121 bytes, base64url without padding (162 characters):

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | `version` = `0x01` |
| 1 | 32 | `endpoint` — Ed25519 public key (the EndpointId) |
| 33 | 8 | `timestamp_ms` — u64, Unix time in ms (client clock) |
| 41 | 16 | `nonce` — random |
| 57 | 64 | `signature` — Ed25519 over `msg` |

```
msg = BLAKE3.derive_key(
        context      = "switchback v1 connect auth",
        key_material = host || 0x00 || endpoint || timestamp_ms || nonce )
host = Host header, lower-cased, port removed, UTF-8
```

Checks, in order:
1. Length 121 and `version == 1` → else `malformed`.
2. `|now_ms − timestamp_ms| ≤ authSkewMs` (default 60 000) → else `stale`.
3. `endpoint` is a valid Ed25519 point and not small-order → else `bad-key`.
4. Strict Ed25519 verification: canonical `S` and `R`, no small-order keys (`@noble/curves`
   `ed25519.verify(sig, msg, pub, { zip215: false })` plus an explicit small-order check; Rust
   `ed25519-dalek` `verify_strict`) → else `bad-signature`.
5. `(endpoint, nonce)` unseen within `2 × authSkewMs` → else `replay` (via `Router.claimNonce`,
   doc 03).

The client builds a fresh blob (new timestamp and nonce) for every connection attempt.

Parity vector (BLAKE3 only): host `cairn.example.net`, all-zero endpoint, timestamp and nonce →
`msg = 31f4b855e7853ca9cd7425ce3b3651246683de3a1927a097b9e3a2a15c80509a`.

### 3.3 Access tokens

Optional per deployment (doc 10). The auth blob proves key ownership; the token proves permission.

---

## 4. Frames

After `101`, both sides exchange **binary** WebSocket messages; each message is exactly one frame:

```
frame = type (u8) || payload
```

Text messages are ignored by both sides. Maximum WebSocket message size: **1 MiB**. Larger → close
1009. No permessage-deflate.

### 4.1 Frame types

| Type | Name | Direction | Payload |
| --- | --- | --- | --- |
| `0x01` | ServerInfo | relay → client | 4.4 |
| `0x02` | Send | client → relay | `dst[32]` · `ecn u8` · `datagram` (rest) |
| `0x03` | SendBatch | client → relay | `dst[32]` · `ecn u8` · `segment_size u16` · `datagrams` (rest) |
| `0x04` | Recv | relay → client | `src[32]` · `ecn u8` · `datagram` |
| `0x05` | RecvBatch | relay → client | `src[32]` · `ecn u8` · `segment_size u16` · `datagrams` |
| `0x06` | PeerGone | relay → client | `peer[32]` |
| `0x07` | Status | relay → client | `code u8` |
| `0x08` | Restarting | relay → client | `reconnect_in_ms u32` · `try_for_ms u32` |

Type `0x00` and all unlisted values are reserved.

- The relay closes the connection with **1002** on any client frame whose type isn't `0x02`/`0x03`.
- Clients **ignore** relay frames of unknown type.

### 4.2 Datagram rules (Send / SendBatch)

- Payload after the type byte ≤ **65 536** bytes → else 1009.
- `Send` ≥ 33 payload bytes; `SendBatch` ≥ 35 and `segment_size ≥ 1` → else 1002.
- `dst` must be a valid, non-small-order Ed25519 key → else 1002.
- `ecn` must be `0..3` (2-bit ECN codepoint) → else 1002.
- `SendBatch` carries datagrams of `segment_size` bytes back to back; the last may be shorter.
  The relay doesn't inspect them.
- An empty datagram in `Send` is allowed.

### 4.3 Forwarding

When the client authenticated as `S` sends to `D`, the relay delivers to `D`'s **active**
connection:

```
Send      0x02 D(32) ecn          data   →   Recv      0x04 S(32) ecn          data
SendBatch 0x03 D(32) ecn seg(2)   data   →   RecvBatch 0x05 S(32) ecn seg(2)   data
```

A byte rewrite of the type and the 32-byte key; `data` is copied at most once and never parsed.

- `D` has no active connection → drop silently.
- `D`'s outbound queue full → drop that frame.
- Sending to yourself is allowed.
- After a successful hand-off, add `D` to `S`'s sent-to set (5.3).

### 4.4 ServerInfo (`0x01`)

The relay's first frame on every connection.

```
max_payload        u32     largest Send/SendBatch payload accepted (65 536)
max_conn_age_s     u32     0 = no limit; else the relay closes the connection after about this long
region_len         u8
region             UTF-8   deployment region or Cloudflare colo (may be empty)
conn_id_len        u8
conn_id            UTF-8   server-side connection id for support and logs
```

Clients must ignore trailing bytes.

### 4.5 Status (`0x07`)

| Code | Name | Meaning |
| --- | --- | --- |
| 0 | Active | This connection receives traffic for the endpoint (sent when an inactive connection is promoted) |
| 1 | Displaced | A newer connection for the same EndpointId took over; this one receives nothing |
| 2 | RateLimited | The relay is dropping or throttling this connection's frames |

Clients ignore unknown codes.

### 4.6 Restarting (`0x08`)

Sent before a planned close (deploy, drain, connection-age limit). The client waits a random time
in `[0, reconnect_in_ms]`, opens a **new** connection while keeping the old one, and closes the old
one once the new one is established (make-before-break). `try_for_ms` bounds how long the client
retries before normal backoff.

---

## 5. Registry semantics

### 5.1 One active connection per EndpointId, newest wins

- A newly connected connection becomes **active**; the previous active one becomes **inactive**
  (stays open, receives nothing) and gets `Status(1 Displaced)`.
- Inactive connections form a stack (most recently displaced last).
- When the active connection closes and inactive ones exist, the most recently displaced one is
  promoted and gets `Status(0 Active)`.
- Closing an inactive connection just removes it.
- Inactive connections may still send.
- At most `maxConnectionsPerEndpoint` (default 4) per EndpointId; a new one beyond that closes the
  oldest inactive connection with 1008.
- Clients close a `Displaced` connection immediately if they opened the newer one themselves
  (make-before-break); otherwise they log a warning (the same key is in use elsewhere).

### 5.2 Outbound queueing

- Per connection at most **512** queued `Recv`/`RecvBatch` frames; beyond that, drop new ones.
- Control frames (ServerInfo, PeerGone, Status, Restarting) have their own cap of 64.
- Hosts with write backpressure (Node) close with 1011 if writes don't drain within 2 s. Hosts
  without it (Workers) cap outbound frames per second instead (doc 04).

### 5.3 PeerGone

- Each EndpointId has a **sent-to set** (bounded, default 4 096, LRU): endpoints any of its
  connections sent datagrams to.
- When endpoint `A` is **fully gone** (last connection closed), each member of `A`'s sent-to set
  with an active connection receives `PeerGone(A)` once. Best-effort.
- Meaning for the recipient: the relayed path to `A` no longer exists; stop sending to `A` via the
  relay until `A` is seen again.

---

## 6. Keepalive and liveness

- **Client:** WebSocket **ping control frame** (8 random bytes) every **15 s**; pong expected within
  **5 s**, else close and reconnect. Platforms answer pings without invoking relay code.
- **Server (Node):** pings every 30 s; terminates after 10 s without a pong.
- **Server (Workers):** no pings; stale sockets are displaced when the client reconnects.

The protocol has no ping or pong frames.

---

## 7. Rate limiting

Optional per-connection token bucket on bytes received (`bytesPerSecond`, `maxBurstBytes ≥ 1 MiB`)
and a frame-rate cap. When exceeded: pause reads where possible (Node), else drop frames (Workers).
Send `Status(2 RateLimited)` at most once per connection. Other abuse caps: doc 10.

---

## 8. Close codes

| Code | When |
| --- | --- |
| 1000 | Normal close; client-initiated; displaced-connection cleanup |
| 1002 | Protocol error: bad type, bad lengths, bad key, bad ECN, `segment_size` 0 |
| 1008 | Replay detected after accept; abuse limit; too many connections for the endpoint |
| 1009 | Message or payload too big |
| 1011 | Internal error; write timeout; lost mailbox |
| 1012 | Restart, drain or max connection age (always preceded by `Restarting`) |

---

## 9. Constants

| Name | Default | Config key |
| --- | --- | --- |
| Max WebSocket message | 1 MiB | fixed |
| Max Send/SendBatch payload | 65 536 B | fixed |
| Auth clock skew | 60 s | `authSkewMs` |
| Nonce replay window | 120 s | `2 × authSkewMs` |
| Recv queue per connection | 512 frames | `outboundQueueFrames` |
| Control queue per connection | 64 frames | `controlQueueFrames` |
| Connections per EndpointId | 4 | `maxConnectionsPerEndpoint` |
| Write drain timeout (Node) | 2 s | `writeTimeoutMs` |
| Client ping interval / pong timeout | 15 s / 5 s | client config |
| Node server ping interval / timeout | 30 s / 10 s | `serverPingMs`, `serverPongTimeoutMs` |
| Sent-to set bound | 4 096 | `sentToMax` |
| Registration buffer | 64 frames | `registeringBufferFrames` |

---

## 10. Test vectors

`packages/core/test/vectors/*.json`, generated by `tools/vectors` from the Rust `switchback-proto`
crate plus hand-written edge cases, used by both the TypeScript core and the Rust client:

- auth blob creation and verification: valid; stale at ±skew boundaries; wrong host; bad signature;
  non-canonical `S`; each of the 8 small-order public keys; wrong length; wrong version byte;
- every frame type encode/decode; every invalid-frame case of 4.2 with its close code;
- forwarding (Send→Recv, SendBatch→RecvBatch, empty datagram);
- ServerInfo with and without trailing bytes; unknown relay frame type and unknown Status code
  (client ignores).
