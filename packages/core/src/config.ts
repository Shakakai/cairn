/**
 * Relay configuration (docs/10) and the pure `Env` the core receives from adapters (docs/02).
 *
 * The core reads time and randomness only through `Env`; it never touches a clock or CSPRNG
 * itself. Defaults are documented in docs/10; full startup validation arrives in M2.
 */

export type AccessMode = "open" | "token";

export interface RelayConfig {
  /** Deployment region, sent in ServerInfo and metrics labels. */
  region: string;
  /** Allowed auth clock skew in ms (doc 01 §3.2). Nonce TTL = 2×. */
  authSkewMs: number;
  access: {
    mode: AccessMode;
    /** Expected token `aud`; defaults to the relay host when unset. */
    audience?: string;
  };
  outboundQueueFrames: number;
  controlQueueFrames: number;
  /** Node only: close a connection whose writes don't drain in this long (doc 01 §5.2). */
  writeTimeoutMs: number;
  /** Node only: server WebSocket ping interval / pong timeout. */
  serverPingMs: number;
  serverPongTimeoutMs: number;
  /** 0 = no limit; else connections recycle after about this long. */
  maxConnectionAgeMs: number;
  sentToMax: number;
  registeringBufferFrames: number;
  maxConnectionsPerEndpoint: number;
  maxNewDestinationsPerMinute: number;
  maxInboundFramesPerSec: number;
  rateLimit: {
    bytesPerSecond?: number;
    maxBurstBytes: number;
  };
  /** doc 03 optional reconnect buffer; 0 = off. */
  reconnectBufferMs: number;
  /** Node shutdown stagger (doc 05). */
  drainWindowMs: number;
  router: {
    kind: "memory" | "redis";
    redis?: { url: string; cluster: boolean };
  };
  /** Cloudflare adapter caps (doc 04). */
  cf: {
    maxOutboundFramesPerSec: number;
    linkIdleMs: number;
    maxLinksPerIsolate: number;
  };
  metrics: { sampleRate: number };
  tls: {
    mode: "offload" | "terminate";
    certFile?: string;
    keyFile?: string;
  };
  ports: { relay: number; admin: number };
  /** Presence/liveness tuning for the Redis router (doc 06). */
  presenceTtlMs: number;
  hostTtlMs: number;
  routeCacheMs: number;
  /** Bound of the in-memory (endpoint, nonce) replay cache, per deployment host. */
  nonceCacheCapacity: number;
}

export const defaultRelayConfig: RelayConfig = {
  region: "",
  authSkewMs: 60_000,
  access: { mode: "open" },
  outboundQueueFrames: 512,
  controlQueueFrames: 64,
  writeTimeoutMs: 2_000,
  serverPingMs: 30_000,
  serverPongTimeoutMs: 10_000,
  maxConnectionAgeMs: 0,
  sentToMax: 4_096,
  registeringBufferFrames: 64,
  maxConnectionsPerEndpoint: 4,
  maxNewDestinationsPerMinute: 120,
  maxInboundFramesPerSec: 2_000,
  rateLimit: { maxBurstBytes: 2_097_152 },
  reconnectBufferMs: 0,
  drainWindowMs: 8_000,
  router: { kind: "memory" },
  cf: {
    maxOutboundFramesPerSec: 2_000,
    // Below the measured platform reap of idle Worker→DO sockets (~60-75s, ADR-016):
    // closing first means the next send reopens transparently instead of vanishing.
    linkIdleMs: 45_000,
    maxLinksPerIsolate: 1_024,
  },
  metrics: { sampleRate: 1 },
  tls: { mode: "offload" },
  ports: { relay: 8_080, admin: 9_090 },
  presenceTtlMs: 60_000,
  hostTtlMs: 15_000,
  routeCacheMs: 2_000,
  nonceCacheCapacity: 100_000,
};

/** Platform capabilities reported by an adapter (docs/02). */
export interface Capabilities {
  /** Platform cut-off (e.g. Cloud Run 3_600_000). The core closes before it. */
  maxConnectionMs?: number;
  /** Node: true (ws.pause/resume); Workers: false (drop instead). */
  canPauseReads: boolean;
  /** Node: true (ws ping/pong); Workers: false. */
  serverPings: boolean;
  /** Deployment region or Cloudflare colo, for ServerInfo. */
  region: string;
}

/**
 * Validate a `RELAY_CONFIG` JSON object (docs/10): unknown keys are an error, values are
 * type-checked, unset keys keep their defaults.
 */
export function validateRelayConfig(raw: unknown): RelayConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("RELAY_CONFIG must be a JSON object");
  }
  const input = raw as Record<string, unknown>;
  const cfg: RelayConfig = {
    ...defaultRelayConfig,
    access: { ...defaultRelayConfig.access },
    rateLimit: { ...defaultRelayConfig.rateLimit },
    router: { ...defaultRelayConfig.router },
    cf: { ...defaultRelayConfig.cf },
    metrics: { ...defaultRelayConfig.metrics },
    tls: { ...defaultRelayConfig.tls },
    ports: { ...defaultRelayConfig.ports },
  };

  const unknown = Object.keys(input).filter(
    (k) =>
      ![
        "region",
        "authSkewMs",
        "access",
        "outboundQueueFrames",
        "controlQueueFrames",
        "writeTimeoutMs",
        "serverPingMs",
        "serverPongTimeoutMs",
        "maxConnectionAgeMs",
        "sentToMax",
        "registeringBufferFrames",
        "maxConnectionsPerEndpoint",
        "maxNewDestinationsPerMinute",
        "maxInboundFramesPerSec",
        "rateLimit",
        "reconnectBufferMs",
        "drainWindowMs",
        "router",
        "cf",
        "metrics",
        "tls",
        "ports",
        "presenceTtlMs",
        "hostTtlMs",
        "routeCacheMs",
        "nonceCacheCapacity",
      ].includes(k),
  );
  if (unknown.length > 0) {
    throw new Error(`RELAY_CONFIG: unknown key(s): ${unknown.join(", ")}`);
  }

  const num = (key: string, min: number): number => {
    const value = input[key];
    if (value === undefined) return NaN; // caller keeps default
    if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
      throw new Error(`RELAY_CONFIG: ${key} must be a number >= ${min}`);
    }
    return value;
  };
  const assign = (key: keyof RelayConfig, value: number): void => {
    if (!Number.isNaN(value)) (cfg as unknown as Record<string, unknown>)[key] = value;
  };

  assign("region", typeof input.region === "string" ? 0 : NaN);
  if (typeof input.region === "string") cfg.region = input.region;
  else if (input.region !== undefined) throw new Error("RELAY_CONFIG: region must be a string");
  assign("authSkewMs", num("authSkewMs", 1_000));
  assign("outboundQueueFrames", num("outboundQueueFrames", 1));
  assign("controlQueueFrames", num("controlQueueFrames", 1));
  assign("writeTimeoutMs", num("writeTimeoutMs", 100));
  assign("serverPingMs", num("serverPingMs", 1_000));
  assign("serverPongTimeoutMs", num("serverPongTimeoutMs", 1_000));
  assign("maxConnectionAgeMs", num("maxConnectionAgeMs", 0));
  assign("sentToMax", num("sentToMax", 1));
  assign("registeringBufferFrames", num("registeringBufferFrames", 1));
  assign("maxConnectionsPerEndpoint", num("maxConnectionsPerEndpoint", 1));
  assign("maxNewDestinationsPerMinute", num("maxNewDestinationsPerMinute", 1));
  assign("maxInboundFramesPerSec", num("maxInboundFramesPerSec", 1));
  assign("reconnectBufferMs", num("reconnectBufferMs", 0));
  assign("drainWindowMs", num("drainWindowMs", 0));
  assign("presenceTtlMs", num("presenceTtlMs", 1_000));
  assign("hostTtlMs", num("hostTtlMs", 1_000));
  assign("routeCacheMs", num("routeCacheMs", 0));
  assign("nonceCacheCapacity", num("nonceCacheCapacity", 1));

  if (input.access !== undefined) {
    const access = section(input.access, "access");
    const mode = access.mode;
    if (mode !== undefined) {
      if (mode !== "open" && mode !== "token")
        throw new Error("RELAY_CONFIG: access.mode must be open|token");
      cfg.access.mode = mode;
    }
    if (access.audience !== undefined) {
      if (typeof access.audience !== "string")
        throw new Error("RELAY_CONFIG: access.audience must be a string");
      cfg.access.audience = access.audience;
    }
    rejectUnknown(access, "access", ["mode", "audience"]);
  }

  if (input.rateLimit !== undefined) {
    const rl = section(input.rateLimit, "rateLimit");
    if (rl.bytesPerSecond !== undefined) {
      if (typeof rl.bytesPerSecond !== "number" || rl.bytesPerSecond <= 0) {
        throw new Error("RELAY_CONFIG: rateLimit.bytesPerSecond must be a number > 0");
      }
      cfg.rateLimit.bytesPerSecond = rl.bytesPerSecond;
    }
    if (rl.maxBurstBytes !== undefined) {
      if (typeof rl.maxBurstBytes !== "number" || rl.maxBurstBytes < 1_048_576) {
        throw new Error("RELAY_CONFIG: rateLimit.maxBurstBytes must be >= 1 MiB");
      }
      cfg.rateLimit.maxBurstBytes = rl.maxBurstBytes;
    }
    rejectUnknown(rl, "rateLimit", ["bytesPerSecond", "maxBurstBytes"]);
  }

  if (input.router !== undefined) {
    const router = section(input.router, "router");
    if (router.kind !== undefined) {
      if (router.kind !== "memory" && router.kind !== "redis") {
        throw new Error("RELAY_CONFIG: router.kind must be memory|redis");
      }
      cfg.router.kind = router.kind;
    }
    if (router.redis !== undefined) {
      const redis = section(router.redis, "router.redis");
      if (redis.url !== undefined) {
        if (typeof redis.url !== "string") throw new Error("RELAY_CONFIG: router.redis.url must be a string");
        cfg.router.redis = { url: redis.url, cluster: cfg.router.redis?.cluster ?? false };
      }
      if (redis.cluster !== undefined) {
        if (typeof redis.cluster !== "boolean")
          throw new Error("RELAY_CONFIG: router.redis.cluster must be a boolean");
        cfg.router.redis = { url: cfg.router.redis?.url ?? "", cluster: redis.cluster };
      }
      rejectUnknown(redis, "router.redis", ["url", "cluster"]);
    }
    rejectUnknown(router, "router", ["kind", "redis"]);
  }

  if (input.cf !== undefined) {
    const cf = section(input.cf, "cf");
    assignCf(cf, "maxOutboundFramesPerSec", (v) => {
      cfg.cf.maxOutboundFramesPerSec = v;
    });
    assignCf(cf, "linkIdleMs", (v) => {
      cfg.cf.linkIdleMs = v;
    });
    assignCf(cf, "maxLinksPerIsolate", (v) => {
      cfg.cf.maxLinksPerIsolate = v;
    });
    rejectUnknown(cf, "cf", ["maxOutboundFramesPerSec", "linkIdleMs", "maxLinksPerIsolate"]);
  }

  if (input.metrics !== undefined) {
    const m = section(input.metrics, "metrics");
    if (m.sampleRate !== undefined) {
      if (typeof m.sampleRate !== "number" || m.sampleRate <= 0 || m.sampleRate > 1) {
        throw new Error("RELAY_CONFIG: metrics.sampleRate must be in (0, 1]");
      }
      cfg.metrics.sampleRate = m.sampleRate;
    }
    rejectUnknown(m, "metrics", ["sampleRate"]);
  }

  if (input.tls !== undefined) {
    const tls = section(input.tls, "tls");
    if (tls.mode !== undefined) {
      if (tls.mode !== "offload" && tls.mode !== "terminate") {
        throw new Error("RELAY_CONFIG: tls.mode must be offload|terminate");
      }
      cfg.tls.mode = tls.mode;
    }
    for (const key of ["certFile", "keyFile"] as const) {
      if (tls[key] !== undefined) {
        if (typeof tls[key] !== "string") throw new Error(`RELAY_CONFIG: tls.${key} must be a string`);
        cfg.tls[key] = tls[key];
      }
    }
    rejectUnknown(tls, "tls", ["mode", "certFile", "keyFile"]);
  }

  if (input.ports !== undefined) {
    const ports = section(input.ports, "ports");
    assignPort(ports, "relay", (v) => {
      cfg.ports.relay = v;
    });
    assignPort(ports, "admin", (v) => {
      cfg.ports.admin = v;
    });
    rejectUnknown(ports, "ports", ["relay", "admin"]);
  }

  return cfg;
}

function section(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`RELAY_CONFIG: ${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(sectionObj: Record<string, unknown>, name: string, allowed: string[]): void {
  const unknown = Object.keys(sectionObj).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw new Error(`RELAY_CONFIG: ${name}: unknown key(s): ${unknown.join(", ")}`);
  }
}

function assignCf(cf: Record<string, unknown>, key: string, set: (v: number) => void): void {
  const value = cf[key];
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    throw new Error(`RELAY_CONFIG: cf.${key} must be a number >= 1`);
  }
  set(value);
}

function assignPort(ports: Record<string, unknown>, key: string, set: (v: number) => void): void {
  const value = ports[key];
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`RELAY_CONFIG: ports.${key} must be an integer in 1..65535`);
  }
  set(value);
}

/** Everything the core needs that adapters provide: time, randomness, config, capabilities.
 * The core performs no I/O and reads no clock outside of this interface.
 */
export interface Env {
  nowMs: number;
  random(n: number): Uint8Array;
  config: RelayConfig;
  caps: Capabilities;
}
