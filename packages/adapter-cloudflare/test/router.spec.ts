/**
 * Router semantics for the Cloudflare mailbox (docs/03), exercised through the
 * conformance `CloudflareRouter` with asynchronous settling. The shared
 * `routerConformance` suite targets in-process routers (memory today, Redis in M6);
 * the mailbox's delivery is asynchronous (Worker→DO sockets), so these tests poll.
 * Fresh endpoints per test keep mailboxes isolated.
 */

import { env } from "cloudflare:test";
import type { RecordingEvent } from "@cairn/conformance";
import { RecordingHost } from "@cairn/conformance";
import { endpointIdFromBytes } from "@cairn/core";
import { describe, expect, it } from "vitest";
import { CloudflareRouter } from "../src/testing/cloudflareRouter.js";
import type { Env } from "../src/types.js";

const bindings = env as unknown as Env;

let unique = 0;
/** Fresh z32 EndpointId per call; keeps each test's mailbox isolated. */
function freshEndpoint(): string {
  unique += 1;
  const bytes = new Uint8Array(32);
  bytes[0] = 0x42;
  bytes[30] = unique & 0xff;
  bytes[31] = unique >> 8;
  return endpointIdFromBytes(bytes);
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

function notify(host: RecordingHost, id: string): string[] {
  return host
    .forConn({ host: "h1", id })
    .filter((e): e is Extract<RecordingEvent, { kind: "notify" }> => e.kind === "notify")
    .map((e) => e.notice);
}

function delivers(host: RecordingHost, id: string): Uint8Array[] {
  return host
    .forConn({ host: "h1", id })
    .filter((e): e is Extract<RecordingEvent, { kind: "deliver" }> => e.kind === "deliver")
    .map((e) => e.frame);
}

/**
 * The push-heavy semantics below (displacement notices, promotion, PeerGone fan-out) need
 * the DO to send on sockets accepted by a (possibly evicted) sibling instance. The local
 * Miniflare alpha used by the vitest plugin silently drops such sends; they are covered
 * end-to-end against real workerd via `scripts/test-cf-host.sh` (host conformance +
 * e2e displacement/gone/replay) and on staging. Re-enable here when the plugin runtime
 * fixes cross-instance sends (tracked in docs/decisions.md, ADR-015).
 */
const crossInstanceSendsWork = false;

describe("router semantics: cloudflare-mailbox", () => {
  it.skipIf(!crossInstanceSendsWork)("1+2. single active, newest wins, notices", async () => {
    const host = new RecordingHost("h1");
    const router = new CloudflareRouter(bindings, host);
    const e = freshEndpoint();
    await router.register(e, { host: "h1", id: "c1" });
    await router.register(e, { host: "h1", id: "c2" });
    await waitFor(() => notify(host, "c1").length === 2 && notify(host, "c2").length === 1);
    expect(notify(host, "c1")).toEqual(["becameActive", "becameInactive"]);
    expect(notify(host, "c2")).toEqual(["becameActive"]);
    for (let i = 0; i < 5; i++) {
      expect(await router.route(e, new Uint8Array([4, i]))).toBe("delivered");
    }
    await waitFor(() => delivers(host, "c2").length === 5);
    expect(delivers(host, "c1")).toHaveLength(0);
    expect(delivers(host, "c2")).toHaveLength(5);
  });

  it("3. notice before data for the newly active connection", async () => {
    const host = new RecordingHost("h1");
    const router = new CloudflareRouter(bindings, host);
    const e = freshEndpoint();
    await router.register(e, { host: "h1", id: "c1" });
    await router.register(e, { host: "h1", id: "c2" });
    await router.route(e, new Uint8Array([4, 9]));
    await waitFor(() => delivers(host, "c2").length === 1);
    const events = host.forConn({ host: "h1", id: "c2" });
    const firstDeliver = events.findIndex((ev) => ev.kind === "deliver");
    const lastNotice = events.map((ev) => ev.kind).lastIndexOf("notify");
    expect(lastNotice).toBeGreaterThanOrEqual(0);
    expect(firstDeliver).toBeGreaterThan(lastNotice);
  });

  it.skipIf(!crossInstanceSendsWork)("4. promotion of the most recently displaced connection", async () => {
    const host = new RecordingHost("h1");
    const router = new CloudflareRouter(bindings, host);
    const e = freshEndpoint();
    await router.register(e, { host: "h1", id: "c1" });
    await router.register(e, { host: "h1", id: "c2" });
    await router.unregister(e, { host: "h1", id: "c2" }, []);
    await waitFor(() => notify(host, "c1").at(-1) === "promoted");
    expect(notify(host, "c1").at(-1)).toBe("promoted");
    expect(await router.route(e, new Uint8Array([4, 1]))).toBe("delivered");
    await waitFor(() => delivers(host, "c1").length === 1);
    expect(delivers(host, "c1")).toHaveLength(1);
  });

  it.skipIf(!crossInstanceSendsWork)(
    "5. gone exactly once per full departure, to each online sent-to member",
    async () => {
      const host = new RecordingHost("h1");
      const router = new CloudflareRouter(bindings, host);
      const a = freshEndpoint();
      const b = freshEndpoint();
      await router.register(a, { host: "h1", id: "ca" });
      await router.register(b, { host: "h1", id: "cb" });
      await router.unregister(a, { host: "h1", id: "ca" }, [b]);
      await waitFor(() => host.peerGones().length === 1);
      expect(host.peerGones()).toHaveLength(1);
      await router.unregister(a, { host: "h1", id: "ca" }, [b]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(host.peerGones()).toHaveLength(1);
    },
  );

  it("6. no buffering for owner-less mailboxes (drop inside the mailbox)", async () => {
    const host = new RecordingHost("h1");
    const router = new CloudflareRouter(bindings, host);
    const e = freshEndpoint();
    // Mailboxes exist on demand on Cloudflare; owner-less frames drop inside (doc 04).
    expect(await router.route(e, new Uint8Array([4, 1]))).toBe("delivered");
    await router.register(e, { host: "h1", id: "c1" });
    await router.unregister(e, { host: "h1", id: "c1" }, []);
    expect(await router.route(e, new Uint8Array([4, 2]))).toBe("delivered");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(delivers(host, "c1")).toHaveLength(0);
  });

  it.skipIf(!crossInstanceSendsWork)(
    "7. per-pair order preserved (binary forwarding through the DO)",
    async () => {
      const host = new RecordingHost("h1");
      const router = new CloudflareRouter(bindings, host);
      const e = freshEndpoint();
      await router.register(e, { host: "h1", id: "c1" });
      const frames = Array.from({ length: 50 }, (_, i) => new Uint8Array([4, i]));
      for (const f of frames) {
        expect(await router.route(e, f)).toBe("delivered");
      }
      await waitFor(() => delivers(host, "c1").length === 50, 8_000);
      expect(delivers(host, "c1").map((f) => f[1])).toEqual(frames.map((f) => f[1]));
    },
  );

  it("8. liveness cleanup is platform-managed (documented no-op)", () => {
    // Cloudflare mailboxes are managed by the platform; dead owners disappear when their
    // sockets close (webSocketClose/webSocketError). See docs/04.
  });

  it("9. replay: claimNonce rejects duplicates within the TTL", async () => {
    const host = new RecordingHost("h1");
    const router = new CloudflareRouter(bindings, host);
    const e = freshEndpoint();
    const nonce = new Uint8Array(16).fill(0x7e);
    expect(await router.claimNonce(e, nonce, 120_000)).toBe(true);
    expect(await router.claimNonce(e, nonce, 120_000)).toBe(false);
    expect(await router.claimNonce(e, new Uint8Array(16).fill(0x7f), 120_000)).toBe(true);
  });
});
