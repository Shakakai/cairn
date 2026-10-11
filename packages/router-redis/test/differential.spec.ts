/**
 * Differential test (docs/06, 08): random register/unregister sequences executed
 * through the Redis Lua scripts must produce exactly the outcomes of `core.registryStep`
 * (≥10 000 ops). Actions are compared as canonical multisets (SMEMBERS order is
 * undefined); registry state (active, inactive stack, sent-to union) after every op
 * must match too.
 */

import { connKey, type EndpointEntry, registryStep } from "@cairn/core";
import fc from "fast-check";
import { Redis } from "ioredis";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REGISTER_LUA, UNREGISTER_LUA } from "../src/lua.js";

const EP = "ep-under-test";
const endpoint = "differential-endpoint";
let container: StartedTestContainer;
let redis: Redis;

describe("Lua registry scripts vs core.registryStep (differential, ≥10k ops)", () => {
  beforeAll(async () => {
    container = await new GenericContainer("redis:7.2.5").withExposedPorts(6379).start();
    redis = new Redis({ host: container.getHost(), port: container.getMappedPort(6379), lazyConnect: true });
    await redis.connect();
  }, 120_000);

  afterAll(async () => {
    redis?.disconnect();
    await container?.stop();
  });

  it("10 000 random ops match exactly", async () => {
    const opArbitrary = fc.record({
      op: fc.constantFrom("register", "unregister"),
      connId: fc.integer({ min: 1, max: 6 }),
      sentTo: fc.array(fc.constantFrom("s1", "s2", "s3"), { maxLength: 2 }),
    });
    const sequenceArbitrary = fc.array(opArbitrary, { minLength: 20, maxLength: 60 });
    let totalOps = 0;

    await fc.assert(
      fc.asyncProperty(sequenceArbitrary, async (ops) => {
        await redis.del(`ep:{${EP}}`, `ep:{${EP}}:sent`);
        let entry: EndpointEntry | undefined;
        for (const raw of ops) {
          totalOps += 1;
          const conn = { host: "h1", id: `c${raw.connId}` };
          let modelOut: string[];
          if (raw.op === "register") {
            const result = registryStep(endpoint, entry, { op: "register", conn });
            entry = result.entry;
            modelOut = canonicalFlat(result.out.flatMap((o) => registryOutToAction(o as RegistryOut)));
            const luaOut = (
              (await redis.eval(
                REGISTER_LUA,
                2,
                `ep:{${EP}}`,
                `ep:{${EP}}:sent`,
                connKey(conn),
                60_000,
                4,
                endpoint,
              )) as unknown[]
            ).map(String);
            expect(canonicalFlat(stripHints(luaOut))).toEqual(modelOut);
          } else {
            const result = registryStep(endpoint, entry, { op: "unregister", conn, sentTo: raw.sentTo });
            entry = result.entry;
            modelOut = canonicalFlat(result.out.flatMap((o) => registryOutToAction(o as RegistryOut)));
            const luaOut = (
              (await redis.eval(
                UNREGISTER_LUA,
                2,
                `ep:{${EP}}`,
                `ep:{${EP}}:sent`,
                connKey(conn),
                60_000,
                4096,
                endpoint,
                ...raw.sentTo,
              )) as unknown[]
            ).map(String);
            expect(canonicalFlat(stripHints(luaOut))).toEqual(modelOut);
          }
          // State comparison after every op.
          const state = await readState();
          const expected = expectedState(entry);
          const ctx = JSON.stringify({ op: raw, state, expected });
          expect(state.active, ctx).toBe(expected.active);
          expect(state.inactive, ctx).toEqual(expected.inactive);
          expect(state.sent, ctx).toEqual(expected.sent);
        }
      }),
      { numRuns: 350 },
    );

    expect(totalOps).toBeGreaterThanOrEqual(10_000);
    console.log(`differential ops executed: ${totalOps}`);
  }, 600_000);
});

type RegistryOut =
  | { notify: { host: string; id: string }; notice: string }
  | { close: { host: string; id: string }; code: number }
  | { gone: { endpoint: string; notifyEndpoints: string[] } }
  | { deleteEntry: true };

function registryOutToAction(o: RegistryOut): string[] {
  if ("notify" in o) {
    return ["notice", connKey(o.notify), o.notice];
  }
  if ("close" in o) {
    return ["close", connKey(o.close), String(o.code)];
  }
  if ("gone" in o) {
    return ["gone", o.gone.endpoint, ...[...o.gone.notifyEndpoints].sort()];
  }
  return []; // deleteEntry is implicit in the Lua DEL; state comparison covers it
}

const OPS = new Set(["notice", "close", "gone", "inval", "deleteEntry"]);

/** Drop the router-level cache hints ("inval" pairs): not registry semantics. */
function stripHints(flat: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < flat.length; ) {
    if (flat[i] === "inval") {
      i += 2;
    } else {
      out.push(flat[i] as string);
      i += 1;
    }
  }
  return out;
}

/** Canonical form of a flat action array: each action on one line, targets inside
 * "gone" sorted, whole thing sorted (SMEMBERS order is undefined). */
function canonicalFlat(flat: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < flat.length) {
    const op = flat[i] as string;
    if (op === "deleteEntry") {
      i += 1;
    } else if (op === "gone") {
      const z = flat[i + 1] as string;
      i += 2;
      const targets: string[] = [];
      while (i < flat.length && !OPS.has(flat[i] as string)) {
        targets.push(flat[i] as string);
        i += 1;
      }
      out.push(["gone", z, ...targets.sort()].join(" "));
    } else {
      out.push([flat[i], flat[i + 1], flat[i + 2]].join(" "));
      i += 3;
    }
  }
  return out.sort();
}

async function readState(): Promise<{ active: string | null; inactive: string[]; sent: string[] }> {
  const active = await redis.hget(`ep:{${EP}}`, "a");
  const rawInactive = await redis.hget(`ep:{${EP}}`, "i");
  const rawSent = await redis.smembers(`ep:{${EP}}:sent`);
  const sent = Array.isArray(rawSent) ? rawSent : [];
  // Redis cJSON encodes an empty Lua table as "{}"; only non-empty stacks are arrays.
  const parsedInactive = rawInactive === null ? [] : (JSON.parse(rawInactive) as unknown);
  const inactive = Array.isArray(parsedInactive) ? parsedInactive : [];
  return {
    active: active ?? null,
    inactive,
    sent: [...sent].sort(),
  };
}

function expectedState(entry: EndpointEntry | undefined): {
  active: string | null;
  inactive: string[];
  sent: string[];
} {
  if (entry === undefined) {
    return { active: null, inactive: [], sent: [] };
  }
  return {
    active: entry.active !== undefined ? connKey(entry.active) : null,
    inactive: entry.inactive.map((c) => connKey(c)),
    sent: [...entry.sentTo].sort(),
  };
}
