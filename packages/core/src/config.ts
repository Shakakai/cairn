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
    linkIdleMs: 60_000,
    maxLinksPerIsolate: 1_024,
  },
  metrics: { sampleRate: 1 },
  tls: { mode: "offload" },
  ports: { relay: 8_080, admin: 9_090 },
  presenceTtlMs: 60_000,
  hostTtlMs: 15_000,
  routeCacheMs: 2_000,
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
 * Everything the core needs that adapters provide: time, randomness, config, capabilities.
 * The core performs no I/O and reads no clock outside of this interface.
 */
export interface Env {
  nowMs: number;
  random(n: number): Uint8Array;
  config: RelayConfig;
  caps: Capabilities;
}
