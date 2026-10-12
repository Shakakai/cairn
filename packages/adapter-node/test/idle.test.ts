/**
 * M3 acceptance: 10 000 concurrent idle connections on one local process without errors.
 * Records RSS/CPU. Skips (with a message) if the OS file-descriptor limit blocks it — CI
 * runners have high limits; local macOS may need `ulimit -n 20000`.
 */

import { TestClient } from "@cairn/conformance";
import { afterAll, describe, expect, it } from "vitest";
import { type RelayHandle, startRelay } from "../src/relay.js";

/** Overridable for dev runs under contention (CI runs the full 10 000). */
const CONNECTIONS = Number(process.env.SOAK_CONNECTIONS ?? 10_000);

describe("idle connection soak (doc 11 M3)", () => {
  let relay: RelayHandle;
  const clients: TestClient[] = [];

  afterAll(async () => {
    for (const c of clients) c.terminate();
    await relay?.close();
  }, 60_000);

  it(`holds ${CONNECTIONS} concurrent idle connections without errors`, { timeout: 180_000 }, async () => {
    relay = await startRelay({
      config: {
        access: { mode: "open" },
        abuse: { upgradesPerMinute: 1_000_000, authFailuresPerMinute: 1_000_000, blockMs: 1_000 },
        region: "soak",
      },
      port: 0,
      adminPort: 0,
    });

    const rssBefore = process.memoryUsage().rss;
    const cpuBefore = process.cpuUsage();
    const startMs = Date.now();

    // Connect in waves; failure to open (EMFILE) skips rather than fails.
    let connected = 0;
    let emfile = false;
    // Distinct seed per connection: 4-byte little-endian index in the first bytes.
    const seedOf = (n: number): Uint8Array => {
      const s = new Uint8Array(32);
      new DataView(s.buffer).setUint32(0, n + 1, true);
      return s;
    };
    const wave = 250;
    for (let i = 0; i < CONNECTIONS; i += wave) {
      const batch = await Promise.allSettled(
        Array.from({ length: wave }, (_, k) => TestClient.connect(relay.url, { seed: seedOf(i + k) })),
      );
      for (const result of batch) {
        if (result.status === "fulfilled") {
          clients.push(result.value);
          connected += 1;
        } else if (String(result.reason).includes("EMFILE")) {
          emfile = true;
        }
      }
      if (emfile) break;
    }

    // Read the ServerInfo of a sample; all sockets are open by definition of connect().
    await clients[0]?.nextFrameOfType("serverInfo");

    // Hold idle across at least one full server keepalive cycle (30s ping + 10s pong
    // timeout) — regression: idle sockets must survive it.
    await new Promise((resolve) => setTimeout(resolve, 33_000));

    const alive = clients.filter((c) => c.readyState === 1).length;
    const elapsed = (Date.now() - startMs) / 1000;
    const rssAfter = process.memoryUsage().rss;
    const cpuAfter = process.cpuUsage(cpuBefore);

    console.log(
      JSON.stringify({
        soak: "idle-connections",
        connected,
        alive,
        serverConnections: relay.connections(),
        wallSeconds: Math.round(elapsed * 10) / 10,
        clientRssMB: Math.round((rssAfter - rssBefore) / 1e6),
        clientCpuSeconds: Math.round((cpuAfter.user + cpuAfter.system) / 1e6) / 1000,
      }),
    );

    if (emfile && connected < CONNECTIONS) {
      console.log(`EMFILE after ${connected} connections; raise ulimit -n to run the full soak`);
    }
    expect(alive).toBe(connected);
    expect(relay.connections()).toBe(connected);
    expect(connected).toBeGreaterThanOrEqual(CONNECTIONS * 0.99);
  });
});
