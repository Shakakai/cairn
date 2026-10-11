# 06 — `packages/router-redis`

Router for container pools. Any Redis-protocol server with **Lua scripting** and **pub/sub**
works: Valkey ≥ 7.2 or Redis ≥ 7 (AWS ElastiCache, GCP Memorystore, Azure Managed Redis /
Azure Cache for Redis, self-hosted). Client library: `ioredis` (supports cluster and sharded
pub/sub).

## Responsibilities

1. **Presence:** which connection is active for each EndpointId, plus the inactive stack and the
   sent-to union, with the exact rules of `core/registry.ts`.
2. **Delivery:** move a frame to the host process that holds the destination's active connection.
3. **Notices:** tell hosts when their connections become active / inactive / promoted.
4. **Liveness:** forget connections of hosts that died without unregistering.

## Data model

All keys for one endpoint share a hash tag so they live in one cluster slot.

| Key | Type | Content | TTL |
| --- | --- | --- | --- |
| `ep:{<z32>}` | HASH | field `a` = active `"<hostId>|<connId>"`; field `i` = JSON array of inactive `"<host>|<conn>"` (stack, most recent last); field `s` = seq counter | `presenceTtlMs` (60 s), refreshed |
| `ep:{<z32>}:sent` | SET | z32 EndpointIds in the sent-to union | same as above |
| `host:{<hostId>}` | STRING | `"1"` | `hostTtlMs` (15 s), refreshed every 5 s |
| `nonce:{<z32>}:<b64nonce>` | STRING | `"1"`, written with `SET NX PX <ttl>` by `claimNonce` | `2 × authSkewMs` |

Channels:

| Channel | Who subscribes | Messages |
| --- | --- | --- |
| `h:{<hostId>}` | that host only | binary envelopes (below) |
| `routes:inval` | every host | z32 of an endpoint whose active connection changed |

In cluster mode use **sharded pub/sub** (`SSUBSCRIBE`/`SPUBLISH`) for `h:{...}` channels.

## Envelope format on `h:{hostId}`

```
u8  kind            1 = deliver frame, 2 = notice, 3 = close (ADR-017)
u16 connIdLen
..  connId (utf8)
..  payload         kind 1: a relay→client frame (Recv, RecvBatch or PeerGone);
                    kind 2: utf8 notice name; kind 3: u16 close code (1008 evictions)
```

Kind 3 covers the registry cap (doc 01 §5.1) evicting an *inactive* connection that
belongs to another host: the registry runs in one Redis primary, so a `close` action may
target a different host than the caller; it is delivered over that host's channel.

## Lua scripts

Implement `register.lua` and `unregister.lua` so they produce **exactly** the outputs of
`core.registryStep` (doc 02). Each returns a flat array of actions the calling host executes:

- `["notice", "<host>|<conn>", "<becameActive|becameInactive|promoted>"]` → if host is self,
  apply locally; else `PUBLISH h:{host}` kind 2.
- `["gone", "<z32 endpoint>", ...notifyZ32s]` → for each notify target: resolve its active
  connection (`HGET ep:{t} a`) and send an `PeerGone(endpoint)` frame (kind 1) to it.
- `["inval", "<z32>"]` → `PUBLISH routes:inval <z32>`.

`register.lua` (KEYS: `ep:{z}`, `ep:{z}:sent`; ARGV: hostConn, ttlMs):

```
old = HGET ep a
if old: push old to i; emit notice(old, becameInactive)
HSET ep a hostConn; HINCRBY ep s 1
PEXPIRE ep ttl; PEXPIRE sent ttl
emit notice(hostConn, becameActive); emit inval(z)
```

`unregister.lua` (KEYS: same; ARGV: hostConn, ttlMs, ...sentToZ32):

```
SADD sent ...sentTo (cap via SCARD; if > maxSentTo, SPOP the excess)
if HGET ep a == hostConn:
    if i non-empty: new = pop last of i; HSET a new; emit notice(new, promoted); emit inval(z)
    else: targets = SMEMBERS sent; DEL ep sent; emit gone(z, targets); emit inval(z)
else if hostConn in i: remove it from i
(refresh TTLs if ep still exists)
```

Store `i` as a small JSON array (it is almost always empty or one element). Use `cjson` in Lua.

## claimNonce(endpoint, nonce, ttlMs)

`SET nonce:{z}:<b64url(nonce)> 1 NX PX ttlMs` → `OK` means fresh (return true), `nil` means
replay (false). Same hash tag as the endpoint keys.

## route(dst, frame)

```
target = routeCache.get(dst)                    // Map<z32, {host, conn, expiresAt}>, TTL routeCacheMs (2000)
if !target: v = HGET ep:{dst} a; if !v → return "offline"; target = parse(v); cache it
if !hostAlive(target.host) → return "offline"   // host liveness cache, TTL 5 s, from EXISTS host:{h}
if target.host == self → host.deliver(target.conn, frame) (local fast path)
else PUBLISH h:{target.host} envelope(kind 1, target.conn, frame)
return "delivered"
```

- `routes:inval` messages evict the cache entry, so displacement takes effect within one pub/sub
  hop rather than the full cache TTL.
- A host receiving a frame for a connection that is not active locally drops it (metric). This is
  the only effect of a stale cache.
- Batch publishes: pipeline PUBLISHes issued in the same event-loop tick.

## Presence refresh and dead hosts

- Every `presenceTtlMs / 3` (20 s), each host pipelines `PEXPIRE` for every `ep:{z}` and
  `ep:{z}:sent` key of its local connections.
- Every 5 s, each host `SET host:{id} 1 PX 15000`.
- If a host dies, its endpoints' keys expire within 60 s; meanwhile `hostAlive()` turns false
  within ~15 s, so routes to it return "offline". Its clients reconnect elsewhere and re-register,
  which overwrites `a`.

## The registering race

`register.lua`'s reply and pub/sub deliveries for the newly active connection travel on different
Redis connections, so a frame can arrive before the reply. The Node adapter buffers deliveries
for a connection in its registering window and applies them after `becameActive` (doc 05).

## Failure behaviour

| Failure | Behaviour |
| --- | --- |
| Redis unreachable at startup | `/readyz` 503; don't accept connections. |
| Redis lost while running | Keep existing connections. Local fast path still works; cross-host routes return "offline" (drop). New upgrades get 503. `/readyz` 503 so the LB stops sending new clients. |
| Pub/sub reconnect | Resubscribe `h:{self}` and `routes:inval`; clear route cache. |

## Throughput notes

Every cross-host relayed frame is one `PUBLISH`. Measure in M7 with the load tool. If a single
primary saturates, switch to cluster mode with sharded pub/sub (host channels spread across
shards). An optional later optimization is a direct host-to-host WebSocket mesh using private IPs
on platforms where instances are addressable (ECS, Container Apps, k8s; not Cloud Run); keep it
behind the same `Router` interface.

## Tests

- `conformance/router.spec.ts` against a real Valkey (Testcontainers) in standalone and cluster mode.
- Lua scripts: differential tests that run random op sequences through both the Lua scripts and
  `core.registryStep` and compare outputs exactly.
- Fault tests: kill a host process; verify routes go offline within 15 s and keys expire.
