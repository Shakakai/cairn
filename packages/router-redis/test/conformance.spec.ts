/**
 * Router conformance (docs/03, 08) for the Redis router: standalone and cluster mode,
 * both against real servers in Testcontainers. selfHost is "h1" so the suite's
 * `conn("h1", …)` connections resolve to the local fast path and the pub/sub loopback.
 */

import { routerConformance } from "@cairn/conformance";
import type { SocketHost } from "@cairn/core";
import { Cluster, Redis } from "ioredis";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisRouter } from "../src/index.js";

const OPTIONS = {
  selfHost: "h1",
  presenceTtlMs: 60_000,
  hostTtlMs: 15_000,
  routeCacheMs: 2_000,
  maxConnectionsPerEndpoint: 4,
  sentToMax: 4096,
};

/** Routers created by the suite, closed in afterAll so no connection leaks. */
const routers: RedisRouter[] = [];
function tracked(client: Redis | Cluster, host: SocketHost): RedisRouter {
  const router = new RedisRouter(client, host, OPTIONS);
  routers.push(router);
  return router;
}
afterAll(async () => {
  await Promise.allSettled(routers.map((r) => r.close()));
});

// ---------------------------------------------------------------------------
// Standalone
// ---------------------------------------------------------------------------

describe("redis router: standalone", () => {
  let container: StartedTestContainer;
  let client: Redis;

  beforeAll(async () => {
    container = await new GenericContainer("redis:7.2.5").withExposedPorts(6379).start();
    client = new Redis({ host: container.getHost(), port: container.getMappedPort(6379), lazyConnect: true });
    await client.connect();
  }, 120_000);

  afterAll(async () => {
    client?.disconnect();
    await container?.stop();
  });

  routerConformance("redis-standalone", (host) => tracked(client, host));
});

// ---------------------------------------------------------------------------
// Cluster (single-node cluster on a fixed port; all 16384 slots on one node)
// ---------------------------------------------------------------------------

describe("redis router: cluster", () => {
  let container: StartedTestContainer;
  let cluster: Cluster;

  beforeAll(async () => {
    container = await new GenericContainer("bitnamilegacy/redis-cluster:7.2.4")
      .withEnvironment({
        ALLOW_EMPTY_PASSWORD: "yes",
        REDIS_NODES: "127.0.0.1:17000 ",
        REDIS_CLUSTER_REPLICAS: "0",
        REDIS_PORT_NUMBER: "17000",
        REDIS_CLUSTER_DYNAMIC_IPS: "no",
        REDIS_CLUSTER_ANNOUNCE_IP: "127.0.0.1",
        REDIS_CLUSTER_ANNOUNCE_PORT: "17000",
        REDIS_CLUSTER_ANNOUNCE_BUS_PORT: "17001",
      })
      .withExposedPorts({ container: 17000, host: 17000 })
      .withStartupTimeout(120_000)
      .start();
    // Single-node cluster bootstrap: epoch first, then assign all slots; the state
    // flips to ok after the cluster-node-timeout elapses (~15s).
    await container.exec([
      "sh",
      "-c",
      "redis-cli -p 17000 cluster set-config-epoch 2 && seq 0 16383 | xargs -n 500 redis-cli -p 17000 cluster addslots && redis-cli -p 17000 cluster saveconfig",
    ]);
    cluster = new Cluster([{ host: "127.0.0.1", port: 17000 }], { clusterRetryStrategy: () => 500 });
    const deadline = Date.now() + 90_000;
    for (;;) {
      const info = await cluster.cluster("INFO").catch(() => "");
      if (String(info).includes("cluster_state:ok")) break;
      if (Date.now() > deadline) throw new Error("single-node cluster did not reach ok state");
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }, 240_000);

  afterAll(async () => {
    cluster?.disconnect();
    await container?.stop();
  });

  it("cluster is reachable", () => {
    expect(cluster.status).toBe("ready");
  });

  routerConformance("redis-cluster", (host) => tracked(cluster, host));
});
