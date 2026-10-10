/**
 * Per-connection state machine (docs/02, 01 §4–7). Given state and an event it returns new
 * state plus effects; adapters execute the effects. Pure: time and randomness come from
 * `Env`.
 *
 * Semantics decided in ADR-012: a frame over the byte/frame budget is dropped (with a
 * `rate_limited` metric) on every host, and hosts that can pause reads additionally get
 * `pauseReads`; `Status(2 RateLimited)` is sent at most once per connection.
 */

import type { Env } from "./config.js";
import {
  type ClientFrame,
  decodeClientFrame,
  encode,
  FrameError,
  forwardTransform,
  MAX_FRAME_PAYLOAD,
} from "./frames.js";
import { type EndpointId, endpointIdFromBytes } from "./keys.js";
import { BoundedSet, FixedWindowCounter, FixedWindowSet, TokenBucket } from "./limits.js";
import type { ConnRef } from "./ports.js";
import type { UpgradeDecision } from "./upgrade.js";

export type ConnectionPhase = "registering" | "open" | "closed";

export interface ConnState {
  conn: ConnRef;
  endpoint: EndpointId;
  endpointBytes: Uint8Array;
  phase: ConnectionPhase;
  /** Set by registry notices; only active connections receive routed data. */
  active: boolean;
  openedAtMs: number;
  /** When set, `timer` at/after this closes the connection (max age, docs/02). */
  closeAtMs?: number;
  /** Status(2 RateLimited) was sent; send it at most once. */
  rateLimitNotified: boolean;
  /** Bytes token bucket; present only when rate limiting is configured. */
  bucket?: TokenBucket;
  /** Per-connection inbound frame-rate cap (maxInboundFramesPerSec, doc 10). */
  framesWindow: FixedWindowCounter;
  /** Distinct-destination abuse cap (maxNewDestinationsPerMinute, doc 10). */
  newDestinations: FixedWindowSet<EndpointId>;
  /** Peers this connection has sent to; reported to the router on close (doc 01 §5.3). */
  sentTo: BoundedSet<EndpointId>;
  /** Reads are paused awaiting quota (avoids duplicate pauseReads effects). */
  pausedReads: boolean;
}

export type Event =
  | { kind: "frame"; bytes: Uint8Array }
  | { kind: "textMessage" }
  | { kind: "registered" }
  | { kind: "registryNotice"; notice: "becameActive" | "becameInactive" | "promoted" }
  | { kind: "deliver"; frame: Uint8Array }
  | { kind: "socketClosed" }
  | { kind: "timer" }
  | { kind: "drain"; reconnectInMs: number; tryForMs: number }
  | { kind: "overQuota" }
  | { kind: "underQuota" };

export type Effect =
  | { kind: "send"; bytes: Uint8Array; priority: "data" | "control" }
  | { kind: "close"; code: number; reason: string }
  | { kind: "timer"; atMs: number }
  | { kind: "register"; endpoint: EndpointId }
  | { kind: "unregister"; endpoint: EndpointId; sentTo: EndpointId[] }
  | { kind: "route"; dst: EndpointId; frame: Uint8Array }
  | { kind: "pauseReads" }
  | { kind: "resumeReads" }
  | { kind: "metric"; name: string; value?: number; labels?: Record<string, string> };

export interface StepResult {
  state: ConnState;
  effects: Effect[];
}

const METRIC_FRAMES_DROPPED = "relay_frames_dropped_total";
const METRIC_STATUS_SENT = "relay_status_sent_total";

/** The max-connection-age actually in force: the smaller of config and platform caps. */
export function effectiveMaxConnectionMs(env: Env): number {
  const configAge = env.config.maxConnectionAgeMs;
  const capAge = env.caps.maxConnectionMs;
  if (configAge > 0 && capAge !== undefined) return Math.min(configAge, capAge);
  if (configAge > 0) return configAge;
  return capAge ?? 0;
}

/** Jitter uniform in [30 s, 120 s] from env.random, so reconnect waves spread out (docs/02). */
function connectionAgeJitterMs(env: Env): number {
  const rand = env.random(4);
  const u32 =
    ((rand[0] ?? 0) | ((rand[1] ?? 0) << 8) | ((rand[2] ?? 0) << 16) | ((rand[3] ?? 0) << 24)) >>> 0;
  return 30_000 + (u32 % 90_001);
}

/**
 * Open a fresh connection: state `registering`, effects `send(ServerInfo)`, `register`,
 * and `timer(closeAtMs)` when a max age applies (docs/02).
 */
export function openConnection(
  args: { conn: ConnRef; decision: Extract<UpgradeDecision, { ok: true }> },
  env: Env,
): StepResult {
  const maxAgeMs = effectiveMaxConnectionMs(env);
  let closeAtMs: number | undefined;
  if (maxAgeMs > 0) {
    closeAtMs = env.nowMs + maxAgeMs - connectionAgeJitterMs(env);
    if (closeAtMs <= env.nowMs) closeAtMs = env.nowMs + 1_000; // tiny ages still close cleanly
  }

  const rateBytesPerSec = env.config.rateLimit.bytesPerSecond;
  const state: ConnState = {
    conn: args.conn,
    endpoint: args.decision.endpoint,
    endpointBytes: args.decision.endpointBytes,
    phase: "registering",
    active: false,
    openedAtMs: env.nowMs,
    ...(closeAtMs !== undefined ? { closeAtMs } : {}),
    rateLimitNotified: false,
    ...(rateBytesPerSec !== undefined
      ? { bucket: new TokenBucket(env.config.rateLimit.maxBurstBytes, rateBytesPerSec, env.nowMs) }
      : {}),
    framesWindow: new FixedWindowCounter(env.config.maxInboundFramesPerSec, 1_000, env.nowMs),
    newDestinations: new FixedWindowSet<EndpointId>(
      env.config.maxNewDestinationsPerMinute,
      60_000,
      env.nowMs,
    ),
    sentTo: new BoundedSet<EndpointId>(env.config.sentToMax),
    pausedReads: false,
  };

  const maxConnAgeS = closeAtMs !== undefined ? Math.max(1, Math.floor((closeAtMs - env.nowMs) / 1_000)) : 0;
  const effects: Effect[] = [
    {
      kind: "send",
      bytes: encode.serverInfo({
        maxPayload: MAX_FRAME_PAYLOAD,
        maxConnAgeS,
        region: env.caps.region,
        connId: args.conn.id,
      }),
      priority: "control",
    },
    { kind: "register", endpoint: args.decision.endpoint },
  ];
  if (closeAtMs !== undefined) {
    effects.push({ kind: "timer", atMs: closeAtMs });
  }
  return { state, effects };
}

function sendEffect(bytes: Uint8Array, priority: "data" | "control"): Effect {
  return { kind: "send", bytes, priority };
}

function dropMetric(reason: string): Effect {
  return { kind: "metric", name: METRIC_FRAMES_DROPPED, value: 1, labels: { reason } };
}

/** Handle a quota breach: drop the frame, pause reads where supported, notify once (ADR-012). */
function overBudget(state: ConnState, env: Env, effects: Effect[]): void {
  effects.push(dropMetric("rate_limited"));
  if (state.pausedReads) return;
  if (env.caps.canPauseReads) {
    state.pausedReads = true;
    effects.push({ kind: "pauseReads" });
  }
  if (!state.rateLimitNotified) {
    state.rateLimitNotified = true;
    effects.push(sendEffect(encode.status(2), "control"));
    effects.push({ kind: "metric", name: METRIC_STATUS_SENT, value: 1, labels: { code: "2" } });
  }
}

function stepFrame(state: ConnState, bytes: Uint8Array, env: Env, effects: Effect[]): ConnState {
  let frame: ClientFrame;
  try {
    frame = decodeClientFrame(bytes);
  } catch (error) {
    if (error instanceof FrameError) {
      effects.push({ kind: "close", code: error.code, reason: error.message });
      return { ...state, phase: "closed" };
    }
    throw error;
  }

  // Rate checks (docs/02): frame-rate cap, then byte budget.
  if (!state.framesWindow.allow(env.nowMs)) {
    overBudget(state, env, effects);
    return state;
  }
  if (state.bucket !== undefined && !state.bucket.tryConsume(bytes.length, env.nowMs)) {
    overBudget(state, env, effects);
    return state;
  }

  const dstBytes = frame.dst;
  const dst = endpointIdFromBytes(dstBytes);
  if (!state.newDestinations.add(dst, env.nowMs)) {
    effects.push(dropMetric("new_dest_cap"));
    return state;
  }

  const relayFrame = forwardTransform(bytes, state.endpointBytes);
  effects.push({ kind: "route", dst, frame: relayFrame });
  state.sentTo.add(dst);
  return state;
}

/** Advance one connection by one event. */
export function step(state: ConnState, ev: Event, env: Env): StepResult {
  // Clone shallowly; nested mutable structures (bucket, windows, sets) are treated as opaque per-step.
  let next: ConnState = { ...state };
  const effects: Effect[] = [];

  if (next.phase === "closed") {
    // Only unregister-once is meaningful after close, and it already ran.
    return { state: next, effects };
  }

  switch (ev.kind) {
    case "frame": {
      next = stepFrame(next, ev.bytes, env, effects);
      break;
    }
    case "textMessage": {
      effects.push({ kind: "metric", name: METRIC_FRAMES_DROPPED, value: 1, labels: { reason: "text" } });
      break;
    }
    case "registered": {
      if (next.phase === "registering") next.phase = "open";
      break;
    }
    case "registryNotice": {
      if (ev.notice === "becameInactive") {
        next.active = false;
        effects.push(sendEffect(encode.status(1), "control"));
        effects.push({ kind: "metric", name: METRIC_STATUS_SENT, value: 1, labels: { code: "1" } });
      } else {
        // becameActive / promoted
        next.active = true;
        effects.push(sendEffect(encode.status(0), "control"));
        effects.push({ kind: "metric", name: METRIC_STATUS_SENT, value: 1, labels: { code: "0" } });
      }
      break;
    }
    case "deliver": {
      if (next.active) {
        effects.push(sendEffect(ev.frame, "data"));
      } else {
        effects.push(dropMetric("inactive"));
      }
      break;
    }
    case "timer": {
      if (next.closeAtMs !== undefined && env.nowMs >= next.closeAtMs) {
        effects.push(sendEffect(encode.restarting(0, 10_000), "control"));
        effects.push({ kind: "close", code: 1012, reason: "max connection age" });
        next.phase = "closed";
      }
      break;
    }
    case "drain": {
      effects.push(sendEffect(encode.restarting(ev.reconnectInMs, ev.tryForMs), "control"));
      effects.push({ kind: "close", code: 1012, reason: "drain" });
      next.phase = "closed";
      break;
    }
    case "socketClosed": {
      next.phase = "closed";
      effects.push({ kind: "unregister", endpoint: next.endpoint, sentTo: next.sentTo.toArray() });
      break;
    }
    case "overQuota": {
      overBudget(next, env, effects);
      break;
    }
    case "underQuota": {
      if (next.pausedReads) {
        next.pausedReads = false;
        effects.push({ kind: "resumeReads" });
      }
      break;
    }
  }

  return { state: next, effects };
}
