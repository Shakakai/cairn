import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Capabilities,
  type ConnState,
  decodeRelayFrame,
  defaultRelayConfig,
  type Effect,
  type Env,
  ed25519PublicKey,
  encode,
  endpointIdFromBytes,
  openConnection,
  type RelayConfig,
  step,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Test plumbing: fake env (docs/02: deterministic clock, seeded RNG).
// ---------------------------------------------------------------------------

function xorshift32(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

function makeEnv(
  options: {
    seed?: number;
    nowMs?: number;
    config?: Partial<RelayConfig>;
    caps?: Partial<Capabilities>;
  } = {},
): { env: Env; advance: (ms: number) => void } {
  const rng = xorshift32(options.seed ?? 42);
  let nowMs = options.nowMs ?? 1_000_000;
  const env: Env = {
    get nowMs() {
      return nowMs;
    },
    set nowMs(v: number) {
      nowMs = v;
    },
    random(n) {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i += 4) {
        const r = rng();
        out[i] = r & 0xff;
        if (i + 1 < n) out[i + 1] = (r >> 8) & 0xff;
        if (i + 2 < n) out[i + 2] = (r >> 16) & 0xff;
        if (i + 3 < n) out[i + 3] = (r >> 24) & 0xff;
      }
      return out;
    },
    config: { ...defaultRelayConfig, ...options.config },
    caps: { canPauseReads: false, serverPings: false, region: "test", ...options.caps },
  };
  return {
    env,
    advance: (ms) => {
      nowMs += ms;
    },
  };
}

const SECRET = new Uint8Array(32).fill(0x11);
const PUBLIC = ed25519PublicKey(SECRET);
const DST = ed25519PublicKey(new Uint8Array(32).fill(0x22));

function decision() {
  return {
    ok: true as const,
    endpoint: "ep",
    endpointBytes: PUBLIC,
    subprotocol: "switchback.v1" as const,
    nonce: new Uint8Array(16),
  };
}

function open(env: Env): { state: ConnState; effects: Effect[] } {
  return openConnection({ conn: { host: "h", id: "c1" }, decision: decision() }, env);
}

function sendFrame(dst: Uint8Array, byte: number): Uint8Array {
  const out = new Uint8Array(1 + 32 + 1 + 1);
  out[0] = 0x02;
  out.set(dst, 1);
  out[33] = 0;
  out[34] = byte;
  return out;
}

const sentStatuses = (effects: Effect[]): number[] =>
  effects
    .filter((e): e is Extract<Effect, { kind: "send" }> => e.kind === "send")
    .map((e) => decodeRelayFrame(e.bytes))
    .filter((f) => f.type === "status")
    .map((f) => (f.type === "status" ? f.code : -1));

// ---------------------------------------------------------------------------
// Deterministic behaviour (doc 02 required tests).
// ---------------------------------------------------------------------------

describe("connection state machine (docs/02)", () => {
  it("openConnection emits ServerInfo, register, timer with jitter bounds", () => {
    const { env } = makeEnv({ config: { maxConnectionAgeMs: 600_000 } });
    const now = env.nowMs;
    const { state, effects } = open(env);

    expect(effects.map((e) => e.kind)).toEqual(["send", "register", "timer"]);
    const serverInfo = effects[0];
    if (serverInfo?.kind !== "send") throw new Error("first effect must be ServerInfo");
    expect(decodeRelayFrame(serverInfo.bytes)).toMatchObject({
      type: "serverInfo",
      maxPayload: 65_536,
      region: "test",
      connId: "c1",
    });
    // Jitter uniform in [30 s, 120 s]: closeAtMs within [now+maxAge-120s, now+maxAge-30s].
    expect(state.closeAtMs).toBeDefined();
    const untilClose = (state.closeAtMs ?? 0) - now;
    expect(untilClose).toBeGreaterThanOrEqual(600_000 - 120_000);
    expect(untilClose).toBeLessThanOrEqual(600_000 - 30_000);
    const timer = effects[2];
    if (timer?.kind !== "timer") throw new Error("third effect must be timer");
    expect(timer.atMs).toBe(state.closeAtMs);
  });

  it("platform cap and config combine: the smaller wins", () => {
    const { env } = makeEnv({
      config: { maxConnectionAgeMs: 600_000 },
      caps: { maxConnectionMs: 300_000 },
    });
    const { state } = open(env);
    const untilClose = (state.closeAtMs ?? 0) - env.nowMs;
    expect(untilClose).toBeLessThanOrEqual(300_000 - 30_000);
  });

  it("no max age: no timer effect", () => {
    const { env } = makeEnv();
    const { effects } = open(env);
    expect(effects.map((e) => e.kind)).toEqual(["send", "register"]);
  });

  it("timer at closeAtMs sends Restarting and closes 1012", () => {
    const { env, advance } = makeEnv({ config: { maxConnectionAgeMs: 600_000 } });
    const { state, effects } = open(env);
    const closeAt = state.closeAtMs ?? 0;
    advance(closeAt - env.nowMs + 1);
    const { state: next, effects: more } = step(state, { kind: "timer" }, env);
    expect(next.phase).toBe("closed");
    const frames = more.filter((e): e is Extract<Effect, { kind: "send" }> => e.kind === "send");
    expect(frames.length).toBe(1);
    expect(decodeRelayFrame(frames[0]?.bytes ?? new Uint8Array())).toMatchObject({
      type: "restarting",
      reconnectInMs: 0,
      tryForMs: 10_000,
    });
    expect(more.at(-1)).toMatchObject({ kind: "close", code: 1012, reason: "max connection age" });
    // Effects of openConnection are untouched.
    expect(effects).toHaveLength(3);
  });

  it("drain sends Restarting(reconnectIn, tryFor) and closes 1012", () => {
    const { env } = makeEnv();
    const { state } = open(env);
    const { state: next, effects } = step(state, { kind: "drain", reconnectInMs: 250, tryForMs: 5_000 }, env);
    expect(next.phase).toBe("closed");
    expect(decodeRelayFrame(effects[0]?.bytes ?? new Uint8Array())).toMatchObject({
      type: "restarting",
      reconnectInMs: 250,
      tryForMs: 5_000,
    });
    expect(effects.at(-1)).toMatchObject({ kind: "close", code: 1012, reason: "drain" });
  });

  it("rate-limit status is sent at most once; frames over the cap are dropped", () => {
    const { env } = makeEnv({ config: { maxInboundFramesPerSec: 5 } });
    const { state } = open(env);
    let current = state;
    const allEffects: Effect[] = [];
    for (let i = 0; i < 20; i++) {
      const result = step(current, { kind: "frame", bytes: sendFrame(DST, i) }, env);
      current = result.state;
      allEffects.push(...result.effects);
    }
    const statuses = allEffects
      .map((e) => (e.kind === "send" ? decodeRelayFrame(e.bytes) : null))
      .filter((f) => f?.type === "status");
    expect(statuses.filter((f) => f?.type === "status" && f.code === 2)).toHaveLength(1);
    // 5 frames allowed, 15 dropped.
    const drops = allEffects.filter((e) => e.kind === "metric" && e.labels?.reason === "rate_limited");
    expect(drops).toHaveLength(15);
    // No routes beyond the cap.
    expect(allEffects.filter((e) => e.kind === "route")).toHaveLength(5);
  });

  it("inactive connections drop deliveries with a metric", () => {
    const { env } = makeEnv();
    const { state } = open(env);
    const inactive = step(state, { kind: "registryNotice", notice: "becameInactive" }, env);
    expect(sentStatuses(inactive.effects)).toEqual([1]);
    const { effects } = step(inactive.state, { kind: "deliver", frame: encode.status(0) }, env);
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ kind: "metric", labels: { reason: "inactive" } });
  });

  it("inactive connections may still send", () => {
    const { env } = makeEnv();
    const { state } = open(env);
    const inactive = step(state, { kind: "registryNotice", notice: "becameInactive" }, env);
    const { effects } = step(inactive.state, { kind: "frame", bytes: sendFrame(DST, 1) }, env);
    expect(effects.some((e) => e.kind === "route")).toBe(true);
  });

  it("text messages are ignored (metric only)", () => {
    const { env } = makeEnv();
    const { state } = open(env);
    const { effects } = step(state, { kind: "textMessage" }, env);
    expect(effects).toHaveLength(1);
    expect(effects[0]?.kind).toBe("metric");
  });

  it("bad client frames close with 1002/1009", () => {
    const { env } = makeEnv();
    const { state } = open(env);
    const bad = step(state, { kind: "frame", bytes: new Uint8Array([0x09]) }, env);
    expect(bad.effects.at(-1)).toMatchObject({ kind: "close", code: 1002 });
    expect(bad.state.phase).toBe("closed");
  });

  it("socketClosed unregisters with the sent-to set and is idempotent", () => {
    const { env } = makeEnv();
    const { state } = open(env);
    const sending = step(state, { kind: "frame", bytes: sendFrame(DST, 1) }, env);
    const closed = step(sending.state, { kind: "socketClosed" }, env);
    expect(closed.effects).toEqual([
      { kind: "unregister", endpoint: "ep", sentTo: [endpointIdFromBytes(DST)] },
    ]);
    expect(closed.state.phase).toBe("closed");
    const again = step(closed.state, { kind: "socketClosed" }, env);
    expect(again.effects).toEqual([]);
  });

  it("pauseReads on Node hosts; resume on underQuota", () => {
    const { env } = makeEnv({ config: { maxInboundFramesPerSec: 1 }, caps: { canPauseReads: true } });
    const { state } = open(env);
    const first = step(state, { kind: "frame", bytes: sendFrame(DST, 1) }, env);
    const second = step(first.state, { kind: "frame", bytes: sendFrame(DST, 2) }, env);
    expect(second.effects.some((e) => e.kind === "pauseReads")).toBe(true);
    const third = step(second.state, { kind: "frame", bytes: sendFrame(DST, 3) }, env);
    expect(third.effects.some((e) => e.kind === "pauseReads")).toBe(false); // idempotent
    const resumed = step(third.state, { kind: "underQuota" }, env);
    expect(resumed.effects).toEqual([{ kind: "resumeReads" }]);
  });
});

// ---------------------------------------------------------------------------
// Property test: random event sequences preserve the SM invariants (doc 08).
// ---------------------------------------------------------------------------

describe("connection state machine properties", () => {
  it("10 000 random event sequences: close is terminal, Status(2) at most once, codes valid", () => {
    const eventArbitrary = fc.constantFrom(
      { kind: "frame" },
      { kind: "frame" },
      { kind: "textMessage" },
      { kind: "registered" },
      { kind: "registryNotice", notice: "becameActive" },
      { kind: "registryNotice", notice: "becameInactive" },
      { kind: "registryNotice", notice: "promoted" },
      { kind: "deliver" },
      { kind: "timer" },
      { kind: "drain", reconnectInMs: 100, tryForMs: 1_000 },
      { kind: "overQuota" },
      { kind: "underQuota" },
      { kind: "socketClosed" },
    );

    fc.assert(
      fc.property(
        fc.array(eventArbitrary, { minLength: 1, maxLength: 100 }),
        fc.integer(),
        (events, seed) => {
          const { env, advance } = makeEnv({
            seed,
            config: { maxInboundFramesPerSec: 50, maxNewDestinationsPerMinute: 5 },
          });
          let { state } = open(env);
          let rateLimitStatuses = 0;
          let closedSeen = false;
          events.forEach((raw, i) => {
            if (i % 7 === 0) advance(250);
            const ev = { ...raw } as Parameters<typeof step>[1];
            if (ev.kind === "frame") {
              (ev as { bytes: Uint8Array }).bytes = sendFrame(DST, i & 0xff);
            }
            if (ev.kind === "deliver") {
              (ev as { frame: Uint8Array }).frame = encode.status(0);
            }
            const { state: next, effects } = step(state, ev, env);
            state = next;

            if (closedSeen) {
              // Close is terminal: no further effects.
              expect(effects).toEqual([]);
              return;
            }
            for (const e of effects) {
              if (e.kind === "close") {
                expect([1002, 1009, 1012]).toContain(e.code);
                closedSeen = true;
              }
              if (e.kind === "send" && sentStatuses([e]).includes(2)) rateLimitStatuses += 1;
            }
            expect(state.sentTo.size).toBeLessThanOrEqual(5);
          });
          expect(rateLimitStatuses).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 10_000 },
    );
  });
});
