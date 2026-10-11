import { TestClient } from "@cairn/conformance";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { type RelayHandle, startRelay } from "../src/relay.js";

const seed = (b: number): Uint8Array => new Uint8Array(32).fill(b);

let relay: RelayHandle | undefined;
afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

async function start(config: Parameters<typeof startRelay>[0]["config"] = {}): Promise<RelayHandle> {
  relay = await startRelay({
    config: { access: { mode: "open" }, ...config },
    port: 0,
    adminPort: 0,
  });
  return relay;
}

describe("relay unit behaviour (doc 05)", () => {
  it("loadConfig: RELAY_CONFIG JSON wins; unknown keys throw", () => {
    const cfg = loadConfig({ RELAY_CONFIG: '{"region":"iad","authSkewMs":30000}' });
    expect(cfg.region).toBe("iad");
    expect(cfg.authSkewMs).toBe(30_000);
    expect(() => loadConfig({ RELAY_CONFIG: '{"bogus":1}' })).toThrow(/unknown key/);
  });

  it("max connection age: Restarting then close 1012", async () => {
    const r = await start({ maxConnectionAgeMs: 1_500 });
    const client = await TestClient.connect(r.url, { seed: seed(1) });
    await client.nextFrameOfType("serverInfo");
    const restarting = await client.nextFrameOfType("restarting", 15_000);
    expect(restarting.reconnectInMs).toBe(0);
    expect(restarting.tryForMs).toBe(10_000);
    const close = await client.waitForClose(15_000);
    expect(close.code).toBe(1012);
  }, 30_000);

  it("rate limit: Status(2) at most once per connection", async () => {
    const r = await start({ maxInboundFramesPerSec: 5 });
    const a = await TestClient.connect(r.url, { seed: seed(2) });
    const b = await TestClient.connect(r.url, { seed: seed(3) });
    await a.nextFrameOfType("serverInfo");
    await b.nextFrameOfType("serverInfo");
    for (let i = 0; i < 30; i++) {
      a.sendDatagram(b.endpointBytes, 0, new Uint8Array([i & 0xff]));
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    // Status(2) arrives on the rate-limited sender, at most once.
    let status2 = 0;
    for (let i = 0; i < 10; i++) {
      try {
        const f = await a.nextFrame(100);
        if (f.type === "status" && f.code === 2) status2 += 1;
      } catch {
        break;
      }
    }
    expect(status2).toBeLessThanOrEqual(1);
    a.close(1000);
    b.close(1000);
  });

  it("drain: Restarting + 1012 on live connections; upgrades get 503; /readyz flips", async () => {
    const r = await start({ drainWindowMs: 300 });
    const client = await TestClient.connect(r.url, { seed: seed(4) });
    await client.nextFrameOfType("serverInfo");

    r.drain();
    const restarting = await client.nextFrameOfType("restarting", 10_000);
    expect(restarting.reconnectInMs).toBe(300);
    const close = await client.waitForClose(10_000);
    expect(close.code).toBe(1012);

    // New upgrades rejected while draining.
    await expect(TestClient.connect(r.url, { seed: seed(5) })).rejects.toMatchObject({ status: 503 });

    // Readiness endpoint on the serving port.
    const ready = await fetch(`${r.url.replace("ws://", "http://")}/healthz?ready=1`);
    expect(ready.status).toBe(503);
  }, 30_000);

  it("registry cap: 5th connection closes the oldest inactive with 1008", async () => {
    const r = await start({ maxConnectionsPerEndpoint: 2 });
    const conns: TestClient[] = [];
    for (let i = 0; i < 4; i++) {
      conns.push(await TestClient.connect(r.url, { seed: seed(6) }));
      await conns[i]?.nextFrameOfType("serverInfo");
    }
    // conns[0] and conns[1] were pushed to the inactive stack; with cap 2 the oldest
    // inactive gets closed with 1008 as newer ones arrive.
    const closes = await Promise.all(conns.slice(0, 2).map((c) => c.waitForClose(10_000)));
    expect(closes.map((c) => c.code)).toEqual([1008, 1008]);
    for (const c of conns.slice(2)) c.close(1000);
  }, 30_000);

  it("admin endpoints: /metrics, /readyz, /livez", async () => {
    const r = await start({});
    const client = await TestClient.connect(r.url, { seed: seed(7) });
    await client.nextFrameOfType("serverInfo");
    const metrics = await fetch(`${r.adminUrl}/metrics`);
    expect(metrics.status).toBe(200);
    const text = await metrics.text();
    expect(text).toContain("relay_connections_opened_total");

    const ready = await fetch(`${r.adminUrl}/readyz`);
    expect(ready.status).toBe(200);

    const live = await fetch(`${r.adminUrl}/livez`);
    expect(live.status).toBe(200);
  });
});
