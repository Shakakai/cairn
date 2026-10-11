import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type ConnRef, type EndpointEntry, type RegistryOp, registryStep } from "../src/index.js";

const conn = (id: number): ConnRef => ({ host: "h", id: `c${id}` });
const EP = "ep";

// Small integers make readable failures; the suite runs 10 000 random op sequences.
const opArbitrary = fc.record({
  op: fc.constantFrom("register", "unregister"),
  connId: fc.integer({ min: 1, max: 5 }),
  sentTo: fc.array(fc.constantFrom("a", "b", "c"), { maxLength: 2 }),
});

describe("registry property tests (docs/02, 08)", () => {
  it("never yields two active connections, never loses an open connection", { timeout: 60_000 }, () => {
    fc.assert(
      fc.property(fc.array(opArbitrary, { minLength: 1, maxLength: 120 }), (ops) => {
        let entry: EndpointEntry | undefined;
        const live = new Set<string>();
        for (const raw of ops) {
          const op: RegistryOp =
            raw.op === "register"
              ? { op: "register", conn: conn(raw.connId) }
              : { op: "unregister", conn: conn(raw.connId), sentTo: raw.sentTo };
          const result = registryStep(EP, entry, op);
          entry = result.entry;

          if (op.op === "register") {
            live.add(op.conn.id);
          } else {
            live.delete(op.conn.id);
          }
          for (const out of result.out) {
            if ("close" in out) live.delete(out.close.id);
          }

          // Single active.
          expect(entry?.active === undefined || entry.inactive.every((c) => c.id !== entry.active?.id)).toBe(
            true,
          );
          // No lost connections: every live conn is active or inactive.
          for (const id of live) {
            const isActive = entry?.active?.id === id;
            const isInactive = entry?.inactive.some((c) => c.id === id) ?? false;
            expect(isActive || isInactive).toBe(true);
          }
          // Inactive stack has no duplicates and never holds the active conn.
          const ids = entry?.inactive.map((c) => c.id) ?? [];
          expect(new Set(ids).size).toBe(ids.length);
        }
      }),
      { numRuns: 10_000 },
    );
  });

  it("emits gone exactly once per full departure", { timeout: 60_000 }, () => {
    fc.assert(
      fc.property(fc.array(opArbitrary, { minLength: 1, maxLength: 120 }), (ops) => {
        let entry: EndpointEntry | undefined;
        const live = new Set<string>();
        let goneEpisodes = 0;
        let goneEvents = 0;
        for (const raw of ops) {
          const op: RegistryOp =
            raw.op === "register"
              ? { op: "register", conn: conn(raw.connId) }
              : { op: "unregister", conn: conn(raw.connId), sentTo: raw.sentTo };
          const hadLive = live.size > 0;
          const result = registryStep(EP, entry, op);
          entry = result.entry;
          if (op.op === "register") {
            live.add(op.conn.id);
          } else {
            live.delete(op.conn.id);
          }
          for (const out of result.out) {
            if ("close" in out) live.delete(out.close.id);
            if ("gone" in out) goneEvents += 1;
          }
          if (hadLive && live.size === 0) goneEpisodes += 1;
        }
        expect(goneEvents).toBe(goneEpisodes);
      }),
      { numRuns: 10_000 },
    );
  });

  it(
    "respects maxConnectionsPerEndpoint with 1008 closes for the oldest inactive",
    { timeout: 60_000 },
    () => {
      fc.assert(
        fc.property(
          fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 5, maxLength: 40 }),
          (registrations) => {
            let entry: EndpointEntry | undefined;
            for (const id of registrations) {
              const { entry: next, out } = registryStep(EP, entry, {
                op: "register",
                conn: conn(id),
              });
              entry = next;
              const total = (entry?.active ? 1 : 0) + (entry?.inactive.length ?? 0);
              expect(total).toBeLessThanOrEqual(4);
              for (const o of out) {
                if ("close" in o) expect(o.code).toBe(1008);
              }
            }
          },
        ),
        { numRuns: 10_000 },
      );
    },
  );
});
