/**
 * The nine Router semantics of docs/03, as a parameterised suite. Runs against:
 * memory (M2), Redis standalone + cluster (M6), Cloudflare mailbox under Miniflare (M5).
 */

import { type ConnRef, endpointIdFromBytes, type Router, type SocketHost } from "@cairn/core";
import { describe, expect, it } from "vitest";
import { RecordingHost } from "./recordingHost.js";

export interface RouterConformanceOptions {
  /** Two hosts, for cross-host routing checks. Memory: same host twice is fine. */
  makeHost?: (id: string) => SocketHost;
  /**
   * Implementations whose route target always exists (e.g. Cloudflare: a mailbox DO is
   * created on demand and drops owner-less frames internally, doc 04) report
   * "delivered" where an in-process router reports "offline". The guarantee under test
   * is identical: nothing is buffered, nothing arrives.
   */
  dropInsideRouter?: boolean;
}

/** Deterministic endpoint key bytes from a small integer (registry tests need not be valid points). */
export function endpointBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes[0] = 0x42;
  bytes[31] = n;
  return bytes;
}

/** Deterministic endpoint ids from a small integer. */
export function endpoint(n: number): string {
  return endpointIdFromBytes(endpointBytes(n));
}

export function conn(host: string, id: string): ConnRef {
  return { host, id };
}

/** Poll until `check()` passes; routers with asynchronous delivery (Cloudflare DOs)
 * need a settle window before assertions. */
async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function routerConformance(
  name: string,
  makeRouter: (host: SocketHost) => Router,
  options: RouterConformanceOptions = {},
): void {
  const makeHost = options.makeHost ?? ((id: string) => new RecordingHost(id));
  const offlineResult: "delivered" | "offline" = options.dropInsideRouter ? "delivered" : "offline";

  describe(`router conformance: ${name}`, () => {
    it("1. single active: only one connection per endpoint receives routed frames", async () => {
      const host = makeHost("h1");
      const router = makeRouter(host);
      const e = endpoint(1);
      const c1 = conn("h1", "c1");
      const c2 = conn("h1", "c2");
      const c3 = conn("h1", "c3");
      await router.register(e, c1);
      await router.register(e, c2);
      await router.register(e, c3);
      for (let i = 0; i < 5; i++) {
        expect(await router.route(e, new Uint8Array([4, i]))).toBe("delivered");
      }
      const recording = host as RecordingHost;
      await waitFor(() => recording.deliversTo(c3).length === 5);
      expect(recording.deliversTo(c1)).toHaveLength(0);
      expect(recording.deliversTo(c2)).toHaveLength(0);
      expect(recording.deliversTo(c3)).toHaveLength(5);
    });

    it("2. newest wins with becameInactive/becameActive notices", async () => {
      const host = makeHost("h1");
      const router = makeRouter(host);
      const e = endpoint(2);
      const c1 = conn("h1", "c1");
      const c2 = conn("h1", "c2");
      await router.register(e, c1);
      await router.register(e, c2);
      const recording = host as RecordingHost;
      await waitFor(() => recording.noticesTo(c1).length === 2);
      expect(recording.noticesTo(c1)).toEqual(["becameActive", "becameInactive"]);
      expect(recording.noticesTo(c2)).toEqual(["becameActive"]);
      expect(await router.route(e, new Uint8Array([4, 1]))).toBe("delivered");
      await waitFor(() => recording.deliversTo(c2).length === 1);
      expect(recording.deliversTo(c2)).toHaveLength(1);
    });

    it("3. notice before data for the newly active connection", async () => {
      const host = makeHost("h1");
      const router = makeRouter(host);
      const e = endpoint(3);
      const c1 = conn("h1", "c1");
      const c2 = conn("h1", "c2");
      await router.register(e, c1);
      await router.register(e, c2);
      await router.route(e, new Uint8Array([4, 9]));
      const recording = host as RecordingHost;
      await waitFor(() => recording.forConn(c2).some((ev) => ev.kind === "deliver"));
      const events = recording.forConn(c2);
      const deliverSeqs = events.filter((ev) => ev.kind === "deliver").map((ev) => ev.seq);
      const noticeSeqs = events.filter((ev) => ev.kind === "notify").map((ev) => ev.seq);
      expect(noticeSeqs.length).toBeGreaterThan(0);
      expect(Math.min(...deliverSeqs)).toBeGreaterThan(Math.max(...noticeSeqs));
    });

    it("4. promotion of the most recently displaced connection", async () => {
      const host = makeHost("h1");
      const router = makeRouter(host);
      const e = endpoint(4);
      const c1 = conn("h1", "c1");
      const c2 = conn("h1", "c2");
      await router.register(e, c1);
      await router.register(e, c2);
      await router.unregister(e, c2, []);
      const recording = host as RecordingHost;
      await waitFor(() => recording.noticesTo(c1).at(-1) === "promoted");
      expect(recording.noticesTo(c1).at(-1)).toBe("promoted");
      expect(await router.route(e, new Uint8Array([4, 1]))).toBe("delivered");
      await waitFor(() => recording.deliversTo(c1).length === 1);
      expect(recording.deliversTo(c1)).toHaveLength(1);
    });

    it("5. gone exactly once per full departure, to each online sent-to member", async () => {
      const host = makeHost("h1");
      const router = makeRouter(host);
      const a = endpoint(5);
      const b = endpoint(6);
      const ca = conn("h1", "ca");
      const cb = conn("h1", "cb");
      await router.register(a, ca);
      await router.register(b, cb);
      await router.unregister(a, ca, [b]);
      const recording = host as RecordingHost;
      await waitFor(() => recording.peerGones().length === 1);
      const gones = recording.peerGones();
      expect(gones).toHaveLength(1);
      expect(gones[0]?.peer).toEqual(endpointBytes(5));
      // A second unregister of the same conn is a no-op: no duplicate PeerGone.
      await router.unregister(a, ca, [b]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(recording.peerGones()).toHaveLength(1);
    });

    it("6. offline destinations drop without buffering", async () => {
      const host = makeHost("h1");
      const router = makeRouter(host);
      expect(await router.route(endpoint(7), new Uint8Array([4, 1]))).toBe(offlineResult);
      // Register, fully leave, then route: still offline, nothing buffered.
      const e = endpoint(7);
      const c = conn("h1", "c1");
      await router.register(e, c);
      await router.unregister(e, c, []);
      expect(await router.route(e, new Uint8Array([4, 2]))).toBe(offlineResult);
      expect((host as RecordingHost).deliversTo(c)).toHaveLength(0);
    });

    it("7. per-pair order preserved", async () => {
      const host = makeHost("h1");
      const router = makeRouter(host);
      const e = endpoint(8);
      const c = conn("h1", "c1");
      await router.register(e, c);
      const frames = Array.from({ length: 50 }, (_, i) => new Uint8Array([4, i]));
      for (const f of frames) {
        await router.route(e, f);
      }
      const got = (host as RecordingHost).deliversTo(c);
      await waitFor(() => got.length === frames.length);
      expect(got.map((f) => f[1])).toEqual(frames.map((f) => f[1]));
    });

    it("8. liveness cleanup: dead-host registrations disappear (presenceTtlMs)", () => {
      // Memory router has no cross-process presence; hosts never "die" here. Implementations
      // with TTL'd presence (Redis, M6) assert real liveness in their own suite runs.
    });

    it("9. replay: claimNonce rejects duplicates within the TTL across the deployment", async () => {
      const host = makeHost("h1");
      const router = makeRouter(host);
      const e = endpoint(9);
      const nonce = new Uint8Array(16).fill(0x7e);
      expect(await router.claimNonce(e, nonce, 120_000)).toBe(true);
      expect(await router.claimNonce(e, nonce, 120_000)).toBe(false);
      // Different nonce, or same nonce on a different endpoint, is fresh.
      expect(await router.claimNonce(e, new Uint8Array(16).fill(0x7f), 120_000)).toBe(true);
      expect(await router.claimNonce(endpoint(10), nonce, 120_000)).toBe(true);
    });
  });
}
