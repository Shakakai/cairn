/**
 * Lua scripts implementing exactly the rules of `core/registry.ts` (docs/02, 06).
 * Each returns a flat action array the calling host executes:
 *   "notice", hostConn, name      → becameActive | becameInactive | promoted
 *   "close",  hostConn, code      → router-initiated close (1008 eviction)
 *   "gone",   z32, z32...         → fully gone; fan out PeerGone to the sent-to union
 *   "inval",  z32                 → active connection changed; evict route caches
 * `hostConn` is always "<hostId>|<connId>".
 */

/**
 * KEYS: ep:{z}, ep:{z}:sent
 * ARGV: hostConn, presenceTtlMs, maxConnections, z32
 */
export const REGISTER_LUA = `
local ep = KEYS[1]
local sent = KEYS[2]
local hostConn = ARGV[1]
local ttlMs = tonumber(ARGV[2])
local maxConnections = tonumber(ARGV[3])
local z = ARGV[4]

local out = {}
local old = redis.call("HGET", ep, "a")

-- Re-register of the currently active connection is a no-op (docs/02).
if old == hostConn then
  return out
end

local rawInactive = redis.call("HGET", ep, "i")
local inactive = rawInactive and cjson.decode(rawInactive) or {}

-- A connection re-registered from the inactive stack moves up (docs/02).
for i = #inactive, 1, -1 do
  if inactive[i] == hostConn then
    table.remove(inactive, i)
  end
end

if old then
  inactive[#inactive + 1] = old
  out[#out + 1] = "notice"
  out[#out + 1] = old
  out[#out + 1] = "becameInactive"
end

redis.call("HSET", ep, "a", hostConn)
redis.call("HINCRBY", ep, "s", 1)

-- Cap: active + inactive must not exceed maxConnections; evict oldest inactive.
while (1 + #inactive) > maxConnections do
  local evicted = table.remove(inactive, 1)
  if not evicted then
    break
  end
  out[#out + 1] = "close"
  out[#out + 1] = evicted
  out[#out + 1] = "1008"
end

redis.call("HSET", ep, "i", cjson.encode(inactive))
redis.call("PEXPIRE", ep, ttlMs)
redis.call("PEXPIRE", sent, ttlMs)

out[#out + 1] = "notice"
out[#out + 1] = hostConn
out[#out + 1] = "becameActive"
out[#out + 1] = "inval"
out[#out + 1] = z
return out
`;

/**
 * KEYS: ep:{z}, ep:{z}:sent
 * ARGV: hostConn, presenceTtlMs, maxSentTo, z32, ...sentToZ32
 */
export const UNREGISTER_LUA = `
local ep = KEYS[1]
local sent = KEYS[2]
local hostConn = ARGV[1]
local ttlMs = tonumber(ARGV[2])
local maxSentTo = tonumber(ARGV[3])
local z = ARGV[4]

local out = {}

-- Unknown endpoint (fully gone, or never seen): no-op (docs/02). Merging sent-to here
-- would resurrect presence keys for an endpoint nobody holds.
if redis.call("EXISTS", ep) == 0 then
  return out
end

-- Merge the reported sent-to set (bounded, doc 01 §5.3).
for i = 5, #ARGV do
  redis.call("SADD", sent, ARGV[i])
end
while redis.call("SCARD", sent) > maxSentTo do
  redis.call("SPOP", sent)
end

local active = redis.call("HGET", ep, "a")
if active ~= hostConn then
  -- Inactive connection leaving: remove it from the stack. Unknown: no-op.
  local rawInactive = redis.call("HGET", ep, "i")
  local inactive = rawInactive and cjson.decode(rawInactive) or {}
  local removed = false
  for i = #inactive, 1, -1 do
    if inactive[i] == hostConn then
      table.remove(inactive, i)
      removed = true
    end
  end
  if removed then
    redis.call("HSET", ep, "i", cjson.encode(inactive))
    redis.call("PEXPIRE", ep, ttlMs)
    redis.call("PEXPIRE", sent, ttlMs)
  end
  return out
end

local rawInactive = redis.call("HGET", ep, "i")
local inactive = rawInactive and cjson.decode(rawInactive) or {}

if #inactive > 0 then
  -- Promote the most recently displaced connection (docs/02).
  local promoted = table.remove(inactive)
  redis.call("HSET", ep, "a", promoted)
  redis.call("HSET", ep, "i", cjson.encode(inactive))
  redis.call("PEXPIRE", ep, ttlMs)
  redis.call("PEXPIRE", sent, ttlMs)
  out[#out + 1] = "notice"
  out[#out + 1] = promoted
  out[#out + 1] = "promoted"
  out[#out + 1] = "inval"
  out[#out + 1] = z
  return out
end

-- Fully gone.
local targets = redis.call("SMEMBERS", sent)
redis.call("DEL", ep)
redis.call("DEL", sent)
out[#out + 1] = "gone"
out[#out + 1] = z
for _, t in ipairs(targets) do
  out[#out + 1] = t
end
out[#out + 1] = "inval"
out[#out + 1] = z
return out
`;
