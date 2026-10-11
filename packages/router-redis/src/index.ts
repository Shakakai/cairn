/**
 * RedisRouter (docs/03, 06): presence in Redis hashes, registry semantics in Lua
 * (differential-tested against `core.registryStep`), delivery via per-host pub/sub
 * channels, nonce claims with SET NX PX, liveness via TTL'd host keys, and the
 * local fast path for connections hosted by this process.
 */

import {
  type ConnRef,
  connKey,
  type EndpointId,
  encode,
  endpointIdToBytes,
  type Router,
  type SocketHost,
} from "@cairn/core";
import { Cluster, Redis, type RedisOptions } from "ioredis";
import { REGISTER_LUA, UNREGISTER_LUA } from "./lua.js";

export interface RedisRouterOptions {
  /** This process's host id (doc 05: platform instance id + random suffix). */
  selfHost: string;
  /** Presence key TTL (doc 10 `presenceTtlMs`). */
  presenceTtlMs: number;
  /** Host liveness key TTL (doc 10 `hostTtlMs`). */
  hostTtlMs: number;
  /** Route cache TTL (doc 10 `routeCacheMs`). */
  routeCacheMs: number;
  /** Registry cap (doc 10 `maxConnectionsPerEndpoint`). */
  maxConnectionsPerEndpoint: number;
  /** Sent-to union bound (doc 10 `sentToMax`). */
  sentToMax: number;
  /** I/O behaviour for tests: refresh cadence overrides. */
  now?: () => number;
}

/** Pub/sub envelope kinds (doc 06, plus kind 3 for cross-host closes — ADR-017). */
const KIND_DELIVER = 1;
const KIND_NOTICE = 2;
const KIND_CLOSE = 3;

const HOST_CHANNEL = (host: string) => `h:{${host}}`;
const ROUTES_INVAL = "routes:inval";

interface RouteTarget {
  host: string;
  conn: ConnRef;
  expiresAt: number;
}

export class RedisRouter implements Router {
  private readonly client: Redis | Cluster;
  private readonly subscriber: Redis | Cluster;
  private readonly ownsSubscriber: boolean;
  /** Resolves once the pub/sub subscription is live and the host key is set. */
  readonly ready: Promise<void>;
  private readonly routeCache = new Map<EndpointId, RouteTarget>();
  private readonly hostAliveCache = new Map<string, number>();
  /** Endpoints with at least one locally-held connection (presence refresh). */
  private readonly localEndpoints = new Map<EndpointId, number>();
  private stopped = false;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private hostKeyTimer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;

  constructor(
    client: Redis | Cluster,
    private readonly host: SocketHost,
    private readonly options: RedisRouterOptions,
    subscriber?: Redis | Cluster,
  ) {
    this.client = client;
    // ioredis emits unhandled 'error' events when the server is briefly unavailable;
    // route handling reports failures via return values, so swallow them here.
    this.client.on("error", () => {});
    this.subscriber = subscriber ?? createSubscriber(client);
    this.subscriber.on("error", () => {});
    this.ownsSubscriber = subscriber === undefined;
    this.now = options.now ?? (() => Date.now());
    this.ready = this.start();
  }

  /** Presence/host key refresh loops (doc 06). */
  private async start(): Promise<void> {
    const self = this.options.selfHost;
    await this.client.set(`host:{${self}}`, "1", "PX", this.options.hostTtlMs).catch(() => {});
    const sub = this.subscriber;
    if (isCluster(sub)) {
      await sub.ssubscribe(HOST_CHANNEL(self));
      await sub.subscribe(ROUTES_INVAL);
    } else {
      await sub.subscribe(HOST_CHANNEL(self), ROUTES_INVAL);
    }
    sub.on("message", (channel: string, message: string) => {
      void this.onMessage(channel, message);
    });
    if (isCluster(sub)) {
      sub.on("smessage", (channel: string, message: string) => {
        void this.onMessage(channel, message);
      });
    }

    this.hostKeyTimer = setInterval(
      () => {
        void this.client.set(`host:{${self}}`, "1", "PX", this.options.hostTtlMs).catch(() => {});
      },
      Math.max(1_000, Math.floor(this.options.hostTtlMs / 3)),
    );
    this.refreshTimer = setInterval(
      () => {
        void this.refreshPresence().catch(() => {});
      },
      Math.max(1_000, Math.floor(this.options.presenceTtlMs / 3)),
    );
  }

  private async refreshPresence(): Promise<void> {
    const ttl = this.options.presenceTtlMs;
    const pipeline = this.client.pipeline();
    for (const endpoint of this.localEndpoints.keys()) {
      pipeline.pexpire(`ep:{${endpoint}}`, ttl);
      pipeline.pexpire(`ep:{${endpoint}}:sent`, ttl);
    }
    await pipeline.exec();
  }

  private async onMessage(channel: string, message: string): Promise<void> {
    if (channel === ROUTES_INVAL) {
      this.routeCache.delete(message);
      return;
    }
    const data = Buffer.from(message, "binary");
    if (data.length < 3) return;
    const kind = data.readUInt8(0);
    const connIdLen = data.readUInt16BE(1);
    if (data.length < 3 + connIdLen) return;
    const connId = data.subarray(3, 3 + connIdLen).toString("utf8");
    const payload = data.subarray(3 + connIdLen);
    const hostId =
      channel.startsWith("h:{") && channel.endsWith("}") ? channel.slice(3, -1) : this.options.selfHost;
    const conn: ConnRef = { host: hostId, id: connId };
    if (kind === KIND_DELIVER) {
      this.host.deliver(conn, new Uint8Array(payload));
    } else if (kind === KIND_NOTICE) {
      const notice = payload.toString("utf8");
      if (notice === "becameActive" || notice === "becameInactive" || notice === "promoted") {
        this.host.notify(conn, notice);
      }
    } else if (kind === KIND_CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1008;
      this.host.close(conn, code, "too many connections for endpoint");
    }
  }

  async register(endpoint: EndpointId, conn: ConnRef): Promise<void> {
    const out = (await this.client.eval(
      REGISTER_LUA,
      2,
      `ep:{${endpoint}}`,
      `ep:{${endpoint}}:sent`,
      connKey(conn),
      this.options.presenceTtlMs,
      this.options.maxConnectionsPerEndpoint,
      endpoint,
    )) as string[];
    this.trackLocal(endpoint, +1);
    this.applyOut(endpoint, out);
  }

  async unregister(endpoint: EndpointId, conn: ConnRef, sentTo: EndpointId[]): Promise<void> {
    const args = [connKey(conn), this.options.presenceTtlMs, this.options.sentToMax, endpoint, ...sentTo];
    const out = (await this.client.eval(
      UNREGISTER_LUA,
      2,
      `ep:{${endpoint}}`,
      `ep:{${endpoint}}:sent`,
      ...args,
    )) as string[];
    this.trackLocal(endpoint, -1);
    this.applyOut(endpoint, out);
  }

  private trackLocal(endpoint: EndpointId, delta: number): void {
    const next = (this.localEndpoints.get(endpoint) ?? 0) + delta;
    if (next <= 0) {
      this.localEndpoints.delete(endpoint);
    } else {
      this.localEndpoints.set(endpoint, next);
    }
  }

  private applyOut(endpoint: EndpointId, out: string[]): void {
    let i = 0;
    const publishes: Promise<unknown>[] = [];
    while (i < out.length) {
      const op = out[i];
      if (op === "notice") {
        const target = parseHostConn(out[i + 1] as string);
        const notice = out[i + 2] as "becameActive" | "becameInactive" | "promoted";
        if (target.host === this.options.selfHost) {
          this.host.notify(target.conn, notice);
        } else {
          publishes.push(this.publish(target.host, KIND_NOTICE, target.conn.id, Buffer.from(notice, "utf8")));
        }
        i += 3;
      } else if (op === "close") {
        const target = parseHostConn(out[i + 1] as string);
        const code = Number(out[i + 2] ?? 1008);
        if (target.host === this.options.selfHost) {
          this.host.close(target.conn, code, "too many connections for endpoint");
        } else {
          const payload = Buffer.alloc(2);
          payload.writeUInt16BE(code, 0);
          publishes.push(this.publish(target.host, KIND_CLOSE, target.conn.id, payload));
        }
        i += 3;
      } else if (op === "gone") {
        const goneEndpoint = out[i + 1] as string;
        i += 2;
        const frame = encode.peerGone(endpointIdToBytes(goneEndpoint));
        const targets: string[] = [];
        while (i < out.length && out[i] !== "inval") {
          targets.push(out[i] as string);
          i += 1;
        }
        for (const target of targets) {
          const active = this.routeCache.get(target);
          void this.deliverResolved(target, frame, active ?? null).catch(() => {});
        }
        void goneEndpoint;
      } else if (op === "inval") {
        this.routeCache.delete(out[i + 1] as string);
        publishes.push(this.client.publish(ROUTES_INVAL, out[i + 1] as string));
        i += 2;
      } else {
        i += 1;
      }
    }
    if (publishes.length > 0) {
      void Promise.allSettled(publishes);
    }
  }

  async route(dst: EndpointId, frame: Uint8Array): Promise<"delivered" | "offline"> {
    const cached = this.routeCache.get(dst);
    const nowMs = this.now();
    let target = cached !== undefined && cached.expiresAt > nowMs ? cached : undefined;
    if (target === undefined) {
      const value = await this.client.hget(`ep:{${dst}}`, "a");
      if (value === null || value === undefined) {
        return "offline";
      }
      target = { ...parseHostConn(value), expiresAt: nowMs + this.options.routeCacheMs };
      this.routeCache.set(dst, target);
    }
    return this.deliverResolved(dst, frame, target);
  }

  private async deliverResolved(
    dst: EndpointId,
    frame: Uint8Array,
    target: { host: string; conn: ConnRef } | null,
  ): Promise<"delivered" | "offline"> {
    if (target === null) {
      const value = await this.client.hget(`ep:{${dst}}`, "a");
      if (value === null || value === undefined) return "offline";
      target = parseHostConn(value);
    }
    if (!(await this.isHostAlive(target.host))) {
      return "offline";
    }
    if (target.host === this.options.selfHost) {
      this.host.deliver(target.conn, frame);
      return "delivered";
    }
    await this.publish(target.host, KIND_DELIVER, target.conn.id, Buffer.from(frame));
    return "delivered";
  }

  private async isHostAlive(hostId: string): Promise<boolean> {
    if (hostId === this.options.selfHost) {
      return true; // we are processing, therefore alive
    }
    const nowMs = this.now();
    const cached = this.hostAliveCache.get(hostId);
    if (cached !== undefined && cached > nowMs) {
      return true;
    }
    const exists = (await this.client.exists(`host:{${hostId}}`)) === 1;
    this.hostAliveCache.set(hostId, nowMs + 5_000);
    return exists;
  }

  private async publish(hostId: string, kind: number, connId: string, payload: Buffer): Promise<void> {
    const connIdBuf = Buffer.from(connId, "utf8");
    const envelope = Buffer.alloc(3 + connIdBuf.length + payload.length);
    envelope.writeUInt8(kind, 0);
    envelope.writeUInt16BE(connIdBuf.length, 1);
    connIdBuf.copy(envelope, 3);
    payload.copy(envelope, 3 + connIdBuf.length);
    if (isCluster(this.client)) {
      await this.client.spublish(HOST_CHANNEL(hostId), envelope.toString("binary"));
    } else {
      await this.client.publish(HOST_CHANNEL(hostId), envelope.toString("binary"));
    }
  }

  async claimNonce(endpoint: EndpointId, nonce: Uint8Array, ttlMs: number): Promise<boolean> {
    const key = `nonce:{${endpoint}}:${Buffer.from(nonce).toString("base64url")}`;
    const result = await this.client.set(key, "1", "PX", ttlMs, "NX");
    return result === "OK";
  }

  localActive(dst: EndpointId): ConnRef | undefined {
    const target = this.routeCache.get(dst);
    if (target !== undefined && target.host === this.options.selfHost && target.expiresAt > this.now()) {
      return target.conn;
    }
    return undefined;
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.refreshTimer !== undefined) clearInterval(this.refreshTimer);
    if (this.hostKeyTimer !== undefined) clearInterval(this.hostKeyTimer);
    // Disconnect first: everything below is best-effort and must not hang when the
    // server is already gone (command queue would otherwise wait forever).
    this.client.disconnect();
    this.subscriber.disconnect();
    if (this.ownsSubscriber) {
      try {
        await Promise.race([
          (async () => {
            await this.subscriber.unsubscribe().catch(() => {});
            if (isCluster(this.subscriber)) await this.subscriber.sunsubscribe().catch(() => {});
          })(),
          new Promise((resolve) => setTimeout(resolve, 1_000)),
        ]);
      } catch {
        // closing anyway
      }
    }
  }

  get stopped_(): boolean {
    return this.stopped;
  }
}

function isCluster(client: Redis | Cluster): client is Cluster {
  return "nodes" in client && (client as Cluster).nodes !== undefined;
}

function createSubscriber(client: Redis | Cluster): Redis | Cluster {
  if (isCluster(client)) {
    // A dedicated subscriber connection for this host's shard channel.
    const anyClient = client as unknown as { startupNodes?: { host: string; port: number }[] };
    const nodes = anyClient.startupNodes ?? [{ host: "127.0.0.1", port: 6379 }];
    return new Cluster(nodes);
  }
  const options = (client as Redis).options;
  const subset: Record<string, unknown> = {};
  for (const key of ["host", "port", "password", "username", "db", "tls"] as const) {
    const value = options[key];
    if (value !== undefined) subset[key] = value;
  }
  return new Redis(subset as unknown as never);
}

function parseHostConn(value: string): { host: string; conn: ConnRef } {
  const sep = value.lastIndexOf("|");
  const host = sep >= 0 ? value.slice(0, sep) : "";
  const id = sep >= 0 ? value.slice(sep + 1) : value;
  return { host, conn: { host, id } };
}
