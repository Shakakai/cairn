/**
 * M6 acceptance: two adapter-node instances sharing a Redis router.
 * - cross-instance delivery (sender and receiver on different instances)
 * - displacement/promotion across instances
 * - kill-a-host: routes go offline within hostTtlMs; keys expire within presenceTtlMs
 * - the shared host conformance suite against an instance backed by Redis
 */

import { hostConformance, TestClient } from "@cairn/conformance";
import { Redis } from "ioredis";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RelayHandle, startRelay } from "../src/relay.js";

let container: StartedTestContainer;
let redisUrl: string;
let redis: Redis;
let relayA: RelayHandle;
let relayB: RelayHandle;

const REDIS_CONFIG = {
  access: { mode: "open" as const },
  router: { kind: "redis" as const, redis: { url: "", cluster: false } },
};

beforeAll(async () => {
  container = await new GenericContainer("redis:7.2.5").withExposedPorts(6379).start();
  redisUrl = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
  redis = new Redis(redisUrl);
  relayA = await startRelay({
    config: { ...REDIS_CONFIG, router: { kind: "redis", redis: { url: redisUrl, cluster: false } } },
    port: 0,
    adminPort: undefined,
    hostId: "node-a",
  });
  relayB = await startRelay({
    config: { ...REDIS_CONFIG, router: { kind: "redis", redis: { url: redisUrl, cluster: false } } },
    port: 0,
    adminPort: undefined,
    hostId: "node-b",
  });
}, 180_000);

afterAll(async () => {
  await relayA?.close();
  await relayB?.close();
  redis?.disconnect();
  await container?.stop();
}, 60_000);

const seed = (b: number): Uint8Array => new Uint8Array(32).fill(b);

describe("two instances + Redis router", () => {
  it("delivers across instances (A on relayA, B on relayB)", async () => {
    const a = await TestClient.connect(relayA.url, { seed: seed(101) });
    const b = await TestClient.connect(relayB.url, { seed: seed(102) });
    await a.nextFrameOfType("serverInfo");
    await b.nextFrameOfType("serverInfo");
    a.sendDatagram(b.endpointBytes, 0, new Uint8Array([1, 2, 3]));
    const recv = await b.nextFrameOfType("recv", 10_000);
    expect(recv.src).toEqual(a.endpointBytes);
    expect(recv.datagram).toEqual(new Uint8Array([1, 2, 3]));
    a.close(1000);
    b.close(1000);
  });

  it("displacement and promotion move traffic across instances", async () => {
    const first = await TestClient.connect(relayA.url, { seed: seed(103) });
    await first.nextFrameOfType("serverInfo");
    await first.nextFrameOfType("status"); // becameActive
    const second = await TestClient.connect(relayB.url, { seed: seed(103) });
    await second.nextFrameOfType("serverInfo");
    await second.nextFrameOfType("status"); // becameActive
    const displaced = await first.nextFrameOfType("status", 10_000);
    expect(displaced.code).toBe(1);

    // Traffic to the shared identity reaches the second connection (on relayB).
    const sender = await TestClient.connect(relayA.url, { seed: seed(104) });
    await sender.nextFrameOfType("serverInfo");
    sender.sendDatagram(second.endpointBytes, 0, new Uint8Array([9]));
    const got = await second.nextFrameOfType("recv", 10_000);
    expect(got.datagram).toEqual(new Uint8Array([9]));

    // Closing the second connection (on relayB) promotes the first (on relayA).
    second.close(1000);
    const promoted = await first.nextFrameOfType("status", 10_000);
    expect(promoted.code).toBe(0);
    sender.sendDatagram(first.endpointBytes, 0, new Uint8Array([8]));
    const got2 = await first.nextFrameOfType("recv", 10_000);
    expect(got2.datagram).toEqual(new Uint8Array([8]));
    first.close(1000);
    sender.close(1000);
  });

  it("kill-a-host: routes go offline ≤ hostTtlMs; keys expire ≤ presenceTtlMs", async () => {
    const victim = await startRelay({
      config: { ...REDIS_CONFIG, router: { kind: "redis", redis: { url: redisUrl, cluster: false } } },
      port: 0,
      adminPort: undefined,
      hostId: "node-victim",
    });
    const v = await TestClient.connect(victim.url, { seed: seed(105) });
    await v.nextFrameOfType("serverInfo");
    await v.nextFrameOfType("status");
    const vId = v.endpointId;

    // Kill: stop host-key renewal and close the router (simulates a dead process).
    const t0 = Date.now();
    await victim.close();
    v.terminate();

    // From relayB, routes to the victim's endpoint must report offline once the
    // host liveness key expires (default hostTtlMs = 15s, doc 10).
    const redis2 = new Redis(redisUrl);
    let offlineAt: number | null = null;
    while (Date.now() - t0 < 30_000) {
      const alive = await redis2.exists(`host:{node-victim}`);
      if (alive === 0) {
        offlineAt = Date.now() - t0;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(offlineAt).not.toBeNull();
    expect(offlineAt as number).toBeLessThanOrEqual(16_000); // hostTtlMs + margin

    // Presence keys expire within presenceTtlMs (60s default, refreshed only by the
    // dead host before it died). Allow margin for the last refresh + TTL.
    const deadline = Date.now() + 75_000;
    for (;;) {
      const active = await redis2.hget(`ep:{${vId}}`, "a");
      if (active === null) break;
      if (Date.now() > deadline)
        throw new Error("presence keys did not expire within presenceTtlMs + margin");
      await new Promise((r) => setTimeout(r, 1_000));
    }
    redis2.disconnect();
  }, 120_000);

  it("host conformance passes against a Redis-backed instance", async () => {
    // Covered by the shared suite registered below; placeholder to keep the
    // describe self-documenting.
  });
});

hostConformance({
  name: "node-redis",
  start: async () => {
    const relay = await startRelay({
      config: { ...REDIS_CONFIG, router: { kind: "redis", redis: { url: redisUrl, cluster: false } } },
      port: 0,
      adminPort: undefined,
      hostId: "node-conformance",
    });
    return { url: relay.url, close: () => relay.close() };
  },
});
