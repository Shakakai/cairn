# 10 — Security, configuration and operations

## Threat model (short)

- The relay never sees plaintext: QUIC between peers is end-to-end encrypted.
- The relay must not let anyone **receive** another endpoint's traffic: registration requires a
  fresh signature by the endpoint's key bound to the relay host (doc 01 §3.2) and a replay check.
- The relay is a **billing surface** (per-message on Cloudflare, per-instance elsewhere): abuse
  limits matter as much as auth.
- Metadata (who talks to whom, when) is visible to the relay. Don't log it beyond aggregate metrics
  and short-form ids needed for debugging; keep logs ≤ 7 days by default.

## Access policy

```ts
export interface AccessPolicy { allow(endpoint: EndpointId, token?: string): Promise<boolean> }
```

Modes (`access.mode`):

| Mode | Behaviour |
| --- | --- |
| `open` | Any endpoint with a valid auth blob may connect. For dev and early testing. |
| `token` (default for staging/prod) | Requires an access token valid for this endpoint. |

### Access token format

Issued by the network's backend (out of scope here; a CLI in `tools/` can mint dev tokens).

```
token = base64url(payload_json) + "." + base64url(ed25519_signature(payload_json_bytes))
payload = { "v":1, "kid":"2026-10", "sub":"<endpoint z32 | *>", "aud":"cairn.example.net",
            "iat": <unix s>, "exp": <unix s> }
```

Verification (pure, `core/tokens.ts`): key by `kid` from `ACCESS_TOKEN_PUBLIC_KEYS` (JSON map
kid→base64 Ed25519 public key), signature strict-valid, `aud` matches host, `iat ≤ now+60 s`,
`exp > now`, `sub` is the connecting endpoint or `*`. Rotation: publish the new kid's key, issue
new tokens, retire the old kid after max token lifetime (default 7 days).

## Abuse limits

| Limit | Default | Enforced in |
| --- | --- | --- |
| Connections per EndpointId (active + inactive) | 4; a 5th closes the oldest inactive with 1008 | Router/registry |
| New destinations per connection per minute | 120 | core (all hosts) |
| Inbound frames per connection per second | 2 000 (drop beyond) | core |
| Inbound bytes per connection per second | off (suggested 1 MB/s for open mode) | core token bucket |
| Outbound frames per connection per second (Workers) | 2 000 | adapter-cloudflare |
| Upgrades per client IP per minute | 60 | Node: in-process per host; Cloudflare: a WAF rate-limiting rule on `/v1/connect` |
| Auth failures per IP per minute | 20 → 429 for 5 min | same |

## Configuration

Single JSON object (`RELAY_CONFIG` or `RELAY_CONFIG_FILE`), validated at startup (`core/config.ts`).
Unknown keys are an error.

| Key | Default | Notes |
| --- | --- | --- |
| `region` | `""` | goes into ServerInfo and metrics |
| `authSkewMs` | 60000 | doc 01 §3.2; nonce TTL = 2× |
| `access.mode` | `"token"` | `open` \| `token` |
| `access.audience` | relay host | expected `aud` |
| `outboundQueueFrames` | 512 | per connection |
| `controlQueueFrames` | 64 | per connection |
| `writeTimeoutMs` | 2000 | Node only |
| `serverPingMs` / `serverPongTimeoutMs` | 30000 / 10000 | Node only |
| `maxConnectionAgeMs` | 0 (none) | combined with platform `caps.maxConnectionMs`; the smaller wins |
| `sentToMax` | 4096 | |
| `registeringBufferFrames` | 64 | |
| `maxConnectionsPerEndpoint` | 4 | |
| `maxNewDestinationsPerMinute` | 120 | |
| `maxInboundFramesPerSec` | 2000 | |
| `rateLimit.bytesPerSecond` / `rateLimit.maxBurstBytes` | off / 2097152 | |
| `reconnectBufferMs` | 0 | doc 03 optional buffer |
| `drainWindowMs` | 8000 | Node shutdown stagger |
| `router.kind` | `"memory"` | `memory` \| `redis` (Node) ; ignored on Cloudflare |
| `router.redis.url` | — | `rediss://…`; cluster: `router.redis.cluster: true` |
| `presenceTtlMs` / `hostTtlMs` / `routeCacheMs` | 60000 / 15000 / 2000 | Redis router |
| `nonceCacheCapacity` | 100000 | bound of the in-memory (endpoint, nonce) replay cache, per host |
| `tls.mode` | `"offload"` | Node: `offload` \| `terminate` (+ `tls.certFile`, `tls.keyFile`) |
| `caps.maxConnectionMs` | unset | set per platform (Cloud Run 3600000) |
| `cf.maxOutboundFramesPerSec` | 2000 | Cloudflare |
| `cf.linkIdleMs` | 45000 | Cloudflare; below the measured ~60-75s platform reap of idle Worker→DO sockets (ADR-016) |
| `cf.maxLinksPerIsolate` | 1024 | Cloudflare |
| `metrics.sampleRate` | 1.0 Node / 0.01 Cloudflare | Analytics Engine writes are sampled |
| `ports.relay` / `ports.admin` | 8080 / 9090 | Node |

## Metrics

Prometheus names (Node `/metrics`); Cloudflare writes the same names as Analytics Engine data points
(blob1 = name, double1 = value, blobs for labels), sampled.

| Metric | Type | Labels |
| --- | --- | --- |
| `relay_connections` | gauge | `state` (active, inactive) |
| `relay_connections_opened_total` | counter | |
| `relay_connections_closed_total` | counter | `code` |
| `relay_upgrade_rejected_total` | counter | `reason` (auth reasons, access, draining, version) |
| `relay_frames_in_total` / `relay_frames_out_total` | counter | `type` |
| `relay_bytes_in_total` / `relay_bytes_out_total` | counter | |
| `relay_frames_dropped_total` | counter | `reason` (offline, queue_full, rate_limited, inactive, link_opening, new_dest_cap) |
| `relay_route_seconds` | histogram | `path` (local, remote) |
| `relay_registry_ops_total` | counter | `op` |
| `relay_status_sent_total` | counter | `code` |
| `relay_endpoint_gone_sent_total` | counter | |
| `relay_router_errors_total` | counter | `kind` |

Dashboards (per deployment): connections, connect/reject rates, frames in/out, drops by reason,
route latency p50/p99, Redis health; on Cloudflare also DO requests and duration from the
GraphQL Analytics API (the cost signal).

## Logging

JSON lines to stdout: `ts, level, msg, host, conn (id), ep (short z32), code, reason, region`.
Never log frame bytes, auth blobs, tokens or full EndpointIds. Debug-level per-frame logging is
compiled out of production builds.

## Runbooks

**Deploy (containers):** rolling update; each old task gets SIGTERM → drain (Restarting +
staggered close) → clients reconnect make-before-break. Watch `relay_connections` dip < 5% and
recover within `drainWindowMs + 10 s`.

**Deploy (Cloudflare):** `wrangler deploy`. Existing sockets may be cut by the runtime update;
clients reconnect. Watch reject and reconnect rates for 10 minutes. Durable Object class changes
need a migration entry.

**Redis outage (pools):** existing connections keep working for same-instance pairs; cross-instance
routes drop; `/readyz` fails so new clients go to healthy instances or retry. Restore Redis; hosts
resubscribe and re-register automatically (each host re-runs `register` for its live connections on
reconnect).

**Abuse spike:** identify by `relay_upgrade_rejected_total` and per-IP limits; tighten
`access.mode`/limits via config; on Cloudflare add a WAF rule.

**Key rotation:** add the new `kid` key to `ACCESS_TOKEN_PUBLIC_KEYS`, deploy, switch the issuer,
remove the old key after the max token lifetime.

**Moving all clients between deployments** (e.g. Cloudflare → containers): clients use one relay
URL, so move the hostname's DNS (keep `cairn.<domain>` as a DNS record you control, pointing at the
active deployment). All endpoints must be on the same deployment to reach each other (doc 12:
federation is future work).
