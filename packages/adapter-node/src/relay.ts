/**
 * The Node SocketHost (doc 05): HTTP surface, WebSocket upgrade flow, per-connection
 * runtime driving `core.connection`, effect execution with queue caps and write timeouts,
 * server keepalives, admin endpoints, and graceful drain.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Duplex } from "node:stream";
import {
  type Capabilities,
  type ConnRef,
  type ConnState,
  defaultRelayConfig,
  type Effect,
  type Env,
  type HealthInfo,
  type HttpResponse,
  type Notice,
  negotiateUpgrade,
  openConnection,
  type RelayConfig,
  type Router,
  routeHttp,
  type SocketHost,
  step,
} from "@cairn/core";
import { MemoryRouter } from "@cairn/router-memory";
import { RedisRouter } from "@cairn/router-redis";
import { Redis } from "ioredis";
import { WebSocket, WebSocketServer } from "ws";
import { Metrics } from "./metrics.js";
import { type AccessPolicy, makeAccessPolicy } from "./policy.js";

const log = (msg: string, fields: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ ts: Date.now(), msg, ...fields }));
};

interface BufferedEvent {
  kind: "deliver" | "notice";
  frame?: Uint8Array;
  notice?: Notice;
}

interface ConnRuntime {
  ws: WebSocket;
  conn: ConnRef;
  state: ConnState;
  queued: Promise<void>;
  registering: boolean;
  buffered: BufferedEvent[];
  timer: NodeJS.Timeout | undefined;
  writeTimeout: NodeJS.Timeout | undefined;
  pendingData: number;
  pendingControl: number;
  lastPongAtMs: number;
  closed: boolean;
}

export interface RelayHandle {
  readonly url: string;
  readonly port: number;
  readonly adminUrl: string;
  readonly hostId: string;
  readonly metrics: Metrics;
  /** Connection count by state (tests/metrics assertions). */
  connections(): number;
  /** Begin graceful drain: stop accepting, stagger `drain` events over drainWindowMs. */
  drain(): void;
  close(): Promise<void>;
}

export interface StartRelayOptions {
  /** Merged over the defaults; access.mode "open" is typical for dev/tests. */
  config?: Partial<RelayConfig>;
  /** Relay listen port; 0 picks an ephemeral port (tests). */
  port?: number;
  /** Admin listen port; 0 picks an ephemeral port; undefined disables the admin server. */
  adminPort?: number;
  hostId?: string;
  accessPolicy?: AccessPolicy;
  health?: HealthInfo;
}

const connKeyOf = (c: ConnRef): string => `${c.host}|${c.id}`;

function lowerCaseHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers[name.toLowerCase()] = value;
  }
  return headers;
}

function parseQuery(req: IncomingMessage): Record<string, string> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    query[key] = value;
  }
  return query;
}

function statusText(status: number): string {
  const texts: Record<number, string> = {
    200: "OK",
    204: "No Content",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    426: "Upgrade Required",
    503: "Service Unavailable",
  };
  return texts[status] ?? "Error";
}

/**
 * Create the relay HTTP(S) server for the configured TLS mode (doc 05): `offload`
 * serves plain HTTP (a load balancer terminates TLS); `terminate` serves TLS with the
 * configured certificate files (VMs, NLB TCP pass-through).
 */
function createRelayServer(config: RelayConfig): Server {
  if (config.tls.mode === "terminate") {
    if (config.tls.certFile === undefined || config.tls.keyFile === undefined) {
      throw new Error("tls.mode=terminate requires tls.certFile and tls.keyFile");
    }
    return createHttpsServer({
      cert: readFileSync(config.tls.certFile),
      key: readFileSync(config.tls.keyFile),
    }) as unknown as Server;
  }
  return createServer();
}

export async function startRelay(options: StartRelayOptions = {}): Promise<RelayHandle> {
  const config: RelayConfig = { ...defaultRelayConfig, ...options.config };
  const hostId = options.hostId ?? `node-${randomBytes(3).toString("hex")}`;
  const health: HealthInfo = options.health ?? {
    version: process.env.npm_package_version ?? "0.0.0",
    commit: process.env.GIT_COMMIT ?? "unknown",
  };
  const caps: Capabilities = { canPauseReads: true, serverPings: true, region: config.region };
  const env = (): Env => ({ nowMs: Date.now(), random: (n) => randomBytes(n), config, caps });

  const metrics = new Metrics();
  metrics.setGauge("relay_connections", 0, { state: "active" });
  metrics.setGauge("relay_connections", 0, { state: "inactive" });
  metrics.setGauge("relay_up", 1);
  const conns = new Map<string, ConnRuntime>();
  const connGauge = new Map<string, number>();
  const policy: AccessPolicy = options.accessPolicy ?? makeAccessPolicy(config, log);
  let draining = false;
  let keepalive: NodeJS.Timeout | undefined;

  let redisClient: Redis | undefined;
  let router: Router;
  if (config.router.kind === "redis") {
    const url = config.router.redis?.url;
    if (url === undefined || url === "") {
      throw new Error("router.kind=redis requires router.redis.url");
    }
    redisClient = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false });
    redisClient.on("error", () => {}); // liveness is surfaced via /readyz (doc 06)
  }
  // The SocketHost implementation is shared by both routers.
  function hostImpl(): SocketHost {
    return new (class implements SocketHost {
      readonly hostId = hostId;
      readonly caps = caps;
      deliver(conn: ConnRef, frame: Uint8Array): void {
        const rt = conns.get(connKeyOf(conn));
        if (rt === undefined || rt.closed) {
          metrics.inc("relay_router_errors_total", 1, { kind: "deliver_unknown" });
          return;
        }
        if (rt.registering) {
          bufferEvent(rt, { kind: "deliver", frame });
          return;
        }
        enqueue(rt, { kind: "deliver", frame });
      }
      notify(conn: ConnRef, notice: Notice): void {
        const rt = conns.get(connKeyOf(conn));
        if (rt === undefined || rt.closed) {
          metrics.inc("relay_router_errors_total", 1, { kind: "notify_unknown" });
          return;
        }
        if (rt.registering) {
          bufferEvent(rt, { kind: "notice", notice });
          return;
        }
        enqueue(rt, { kind: "registryNotice", notice });
      }
      close(conn: ConnRef, code: number, reason: string): void {
        const rt = conns.get(connKeyOf(conn));
        if (rt !== undefined) closeConn(rt, code, reason);
      }
    })();
  }

  if (config.router.kind === "redis") {
    router = new RedisRouter(redisClient as Redis, hostImpl(), {
      selfHost: hostId,
      presenceTtlMs: config.presenceTtlMs,
      hostTtlMs: config.hostTtlMs,
      routeCacheMs: config.routeCacheMs,
      maxConnectionsPerEndpoint: config.maxConnectionsPerEndpoint,
      sentToMax: config.sentToMax,
    });
  } else {
    router = new MemoryRouter(hostImpl(), {
      maxConnectionsPerEndpoint: config.maxConnectionsPerEndpoint,
      sentToMax: config.sentToMax,
      nonceCacheCapacity: config.nonceCacheCapacity,
    });
  }

  // -------------------------------------------------------------------------
  // Per-connection runtime.
  // -------------------------------------------------------------------------

  function bufferEvent(rt: ConnRuntime, event: BufferedEvent): void {
    if (rt.buffered.length >= config.registeringBufferFrames) {
      metrics.inc("relay_frames_dropped_total", 1, { reason: "registering_buffer_full" });
      return;
    }
    rt.buffered.push(event);
  }

  function flushBuffered(rt: ConnRuntime): void {
    const notices = rt.buffered.filter((e) => e.kind === "notice");
    const delivers = rt.buffered.filter((e) => e.kind === "deliver");
    rt.buffered = [];
    for (const e of notices) enqueue(rt, { kind: "registryNotice", notice: e.notice as Notice });
    for (const e of delivers) enqueue(rt, { kind: "deliver", frame: e.frame as Uint8Array });
  }

  function enqueue(rt: ConnRuntime, ev: Parameters<typeof step>[1]): void {
    rt.queued = rt.queued.then(() => {
      if (rt.closed && ev.kind !== "socketClosed") return;
      const { state, effects } = step(rt.state, ev, env());
      rt.state = state;
      runEffects(rt, effects);
    });
    rt.queued = rt.queued.catch((error: unknown) => {
      log("connection step failed", { conn: rt.conn.id, error: String(error) });
      metrics.inc("relay_router_errors_total", 1, { kind: "step" });
      closeConn(rt, 1011, "internal error");
    });
  }

  function runEffects(rt: ConnRuntime, effects: Effect[]): void {
    for (const effect of effects) execEffect(rt, effect);
  }

  function execEffect(rt: ConnRuntime, effect: Effect): void {
    switch (effect.kind) {
      case "send":
        sendFrame(rt, effect.bytes, effect.priority);
        break;
      case "close":
        closeConn(rt, effect.code, effect.reason);
        enqueue(rt, { kind: "socketClosed" });
        break;
      case "timer":
        if (rt.timer !== undefined) clearTimeout(rt.timer);
        rt.timer = setTimeout(() => enqueue(rt, { kind: "timer" }), Math.max(0, effect.atMs - Date.now()));
        break;
      case "register":
        rt.registering = true;
        router
          .register(effect.endpoint, rt.conn)
          .then(() => {
            rt.registering = false;
            enqueue(rt, { kind: "registered" });
            flushBuffered(rt);
          })
          .catch((error: unknown) => {
            log("register failed", { conn: rt.conn.id, error: String(error) });
            metrics.inc("relay_router_errors_total", 1, { kind: "register" });
            closeConn(rt, 1011, "register failed");
          });
        break;
      case "unregister":
        router.unregister(effect.endpoint, rt.conn, effect.sentTo).catch((error: unknown) => {
          log("unregister failed", { conn: rt.conn.id, error: String(error) });
          metrics.inc("relay_router_errors_total", 1, { kind: "unregister" });
        });
        break;
      case "route": {
        // Local fast path (doc 05): deliver here when this process holds the active
        // connection; otherwise hand to the router. Never block the read loop (doc 03).
        const local = router.localActive(effect.dst);
        if (local !== undefined) {
          const rt = conns.get(connKeyOf(local));
          if (rt !== undefined && !rt.closed) {
            enqueue(rt, { kind: "deliver", frame: effect.frame });
            break;
          }
        }
        router.route(effect.dst, effect.frame).then(
          (result: "delivered" | "offline") => {
            if (result === "offline") {
              metrics.inc("relay_frames_dropped_total", 1, { reason: "offline" });
            }
          },
          (error: unknown) => {
            log("route failed", { error: String(error) });
            metrics.inc("relay_router_errors_total", 1, { kind: "route" });
          },
        );
        break;
      }
      case "pauseReads":
        rt.ws.pause();
        break;
      case "resumeReads":
        rt.ws.resume();
        break;
      case "metric":
        metrics.inc(effect.name, effect.value ?? 1, effect.labels);
        break;
    }
  }

  function sendFrame(rt: ConnRuntime, bytes: Uint8Array, priority: "data" | "control"): void {
    if (rt.closed) return;
    const pendingKey = priority === "data" ? "pendingData" : "pendingControl";
    const cap = priority === "data" ? config.outboundQueueFrames : config.controlQueueFrames;
    if (rt[pendingKey] >= cap) {
      metrics.inc("relay_frames_dropped_total", 1, { reason: "queue_full" });
      return;
    }
    rt[pendingKey] += 1;
    if (rt.pendingData === 1) {
      rt.writeTimeout = setTimeout(() => {
        if (rt.pendingData > 0) closeConn(rt, 1011, "write timeout");
      }, config.writeTimeoutMs);
    }
    rt.ws.send(bytes, { binary: true }, (error) => {
      rt[pendingKey] -= 1;
      if (rt.pendingData === 0 && rt.writeTimeout !== undefined) {
        clearTimeout(rt.writeTimeout);
        rt.writeTimeout = undefined;
      }
      if (error !== undefined && error !== null) closeConn(rt, 1011, "write error");
    });
  }

  function adjustConnGauge(rt: ConnRuntime, delta: number): void {
    const state = rt.state.active ? "active" : "inactive";
    connGauge.set(state, Math.max(0, (connGauge.get(state) ?? 0) + delta));
    metrics.setGauge("relay_connections", connGauge.get(state) ?? 0, { state });
  }

  function closeConn(rt: ConnRuntime, code: number, reason: string): void {
    if (rt.closed) return;
    rt.closed = true;
    if (rt.timer !== undefined) clearTimeout(rt.timer);
    if (rt.writeTimeout !== undefined) clearTimeout(rt.writeTimeout);
    metrics.inc("relay_connections_closed_total", 1, { code: String(code) });
    adjustConnGauge(rt, -1);
    try {
      if (rt.ws.readyState === WebSocket.OPEN) {
        rt.ws.close(code, reason);
      } else {
        rt.ws.terminate();
      }
    } catch {
      // already gone
    }
  }

  function onConnection(ws: WebSocket, decision: { endpoint: string; endpointBytes: Uint8Array }): void {
    const conn: ConnRef = { host: hostId, id: randomBytes(8).toString("hex") };
    const rt: ConnRuntime = {
      ws,
      conn,
      state: undefined as unknown as ConnState,
      queued: Promise.resolve(),
      registering: false,
      buffered: [],
      timer: undefined,
      writeTimeout: undefined,
      pendingData: 0,
      pendingControl: 0,
      lastPongAtMs: Date.now(),
      closed: false,
    };
    conns.set(connKeyOf(conn), rt);
    const opened = openConnection(
      { conn, decision: { ok: true, subprotocol: "switchback.v1", nonce: new Uint8Array(0), ...decision } },
      env(),
    );
    rt.state = opened.state;
    metrics.inc("relay_connections_opened_total");
    adjustConnGauge(rt, +1);
    runEffects(rt, opened.effects);

    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        enqueue(rt, { kind: "frame", bytes: new Uint8Array(data) });
      } else {
        enqueue(rt, { kind: "textMessage" });
      }
    });
    ws.on("pong", () => {
      rt.lastPongAtMs = Date.now();
    });
    ws.on("close", () => {
      conns.delete(connKeyOf(conn));
      enqueue(rt, { kind: "socketClosed" });
    });
    ws.on("error", () => {
      closeConn(rt, 1011, "socket error");
    });
  }

  // -------------------------------------------------------------------------
  // HTTP surface + upgrade flow (docs/01 §2, doc 05).
  // -------------------------------------------------------------------------

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1 << 20, // doc 01: 1 MiB max WebSocket message
    perMessageDeflate: false,
    handleProtocols: (offered) => (offered.has("switchback.v1") ? "switchback.v1" : false),
  });

  function writeHttpError(
    socket: Duplex,
    error: { status: number; body: string; headers?: Record<string, string> },
  ): void {
    const headers = { "Content-Type": "text/plain", Connection: "close", ...error.headers };
    const head =
      `HTTP/1.1 ${error.status} ${statusText(error.status)}\r\n` +
      `${Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\r\n")}\r\n` +
      `Content-Length: ${Buffer.byteLength(error.body)}\r\n\r\n`;
    socket.write(head + error.body, () => socket.destroy());
  }

  function handleRequest(req: IncomingMessage, res: import("node:http").ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz" && url.searchParams.has("ready")) {
      // Drain-aware readiness on the serving port (doc 05); with a Redis router the
      // connection must be up too (doc 06).
      const redisUp = redisClient === undefined || redisClient.status === "ready";
      const ok = !draining && redisUp;
      res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: ok ? "ok" : "draining" }));
      return;
    }
    const response: HttpResponse = routeHttp(
      { method: req.method ?? "GET", path: url.pathname, headers: lowerCaseHeaders(req) },
      health,
    );
    res.writeHead(response.status, response.headers);
    res.end(response.body);
  }

  const server: Server =
    config.tls.mode === "terminate" ? createRelayServer(config) : createServer(handleRequest);
  if (config.tls.mode === "terminate") {
    server.on("request", handleRequest);
  }

  server.on("upgrade", (req, socket, head) => {
    (async () => {
      if (draining) {
        writeHttpError(socket, { status: 503, body: "draining", headers: { "Retry-After": "1" } });
        return;
      }
      const decision = negotiateUpgrade(
        {
          method: req.method ?? "GET",
          path: new URL(req.url ?? "/", "http://localhost").pathname,
          headers: lowerCaseHeaders(req),
          query: parseQuery(req),
        },
        env(),
      );
      if (!decision.ok) {
        metrics.inc("relay_upgrade_rejected_total", 1, { reason: decision.body.split(":")[0] ?? "unknown" });
        writeHttpError(socket, decision);
        return;
      }
      if (!(await router.claimNonce(decision.endpoint, decision.nonce, 2 * config.authSkewMs))) {
        metrics.inc("relay_upgrade_rejected_total", 1, { reason: "auth" });
        writeHttpError(socket, { status: 401, body: "auth: replay" });
        return;
      }
      if (!(await policy.allow(decision.endpoint, decision.token))) {
        metrics.inc("relay_upgrade_rejected_total", 1, { reason: "access" });
        writeHttpError(socket, { status: 403, body: "access denied" });
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, decision));
    })().catch((error: unknown) => {
      log("upgrade failed", { error: String(error) });
      metrics.inc("relay_upgrade_rejected_total", 1, { reason: "internal" });
      try {
        writeHttpError(socket, { status: 500, body: "internal error" });
      } catch {
        socket.destroy();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Admin server: /metrics, /readyz, /livez (doc 05).
  // -------------------------------------------------------------------------

  let adminServer: Server | undefined;
  let adminUrl = "";
  const drainImpl: () => void = () => {};

  if (options.adminPort !== undefined) {
    adminServer = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/metrics") {
        res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
        res.end(metrics.render());
        return;
      }
      if (url.pathname === "/drain" && req.method === "POST") {
        // Ops trigger for the graceful drain (doc 05); e2e `restart` uses this.
        drainImpl();
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ draining: true }));
        return;
      }
      if (url.pathname === "/readyz") {
        const ready = !draining;
        res.writeHead(ready ? 200 : 503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ready }));
        return;
      }
      if (url.pathname === "/livez") {
        const start = process.hrtime.bigint();
        setImmediate(() => {
          const delayMs = Number(process.hrtime.bigint() - start) / 1e6;
          const alive = delayMs < 1_000;
          res.writeHead(alive ? 200 : 503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ alive, loopDelayMs: Math.round(delayMs) }));
        });
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    });
  }

  // -------------------------------------------------------------------------
  // Start, keepalive, drain, shutdown.
  // -------------------------------------------------------------------------

  // A Redis router must have its subscription live before we accept traffic, or the
  // first frames published to this host vanish (docs/05, 06).
  await router.ready;

  const port = options.port ?? config.ports.relay;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, resolve);
  });
  const boundPort = (server.address() as { port: number }).port;

  if (adminServer !== undefined) {
    await new Promise<void>((resolve, reject) => {
      adminServer?.once("error", reject);
      adminServer?.listen(options.adminPort ?? config.ports.admin, resolve);
    });
    const adminPort = (adminServer.address() as { port: number }).port;
    adminUrl = `http://127.0.0.1:${adminPort}`;
  }

  keepalive = setInterval(() => {
    const now = Date.now();
    for (const rt of conns.values()) {
      if (rt.closed) continue;
      // Allow one full ping interval plus the pong timeout before declaring death: a live
      // client answers each ping within the interval, refreshing lastPongAtMs.
      if (now - rt.lastPongAtMs > config.serverPingMs + config.serverPongTimeoutMs) {
        rt.ws.terminate();
      } else {
        try {
          rt.ws.ping();
        } catch {
          // closed mid-iteration
        }
      }
    }
  }, config.serverPingMs);
  keepalive.unref();

  log("cairn node adapter listening", {
    port: boundPort,
    admin: adminUrl || "disabled",
    host: hostId,
    region: config.region,
    router: config.router.kind,
  });

  return {
    url: `ws://127.0.0.1:${boundPort}`,
    port: boundPort,
    adminUrl,
    hostId,
    metrics,
    connections: () => conns.size,
    drain(): void {
      if (draining) return;
      draining = true;
      const window = config.drainWindowMs;
      for (const rt of conns.values()) {
        const offset = Math.floor(Math.random() * window);
        setTimeout(
          () => enqueue(rt, { kind: "drain", reconnectInMs: window, tryForMs: window + 2_000 }),
          offset,
        );
      }
    },
    async close(): Promise<void> {
      draining = true;
      if (keepalive !== undefined) clearInterval(keepalive);
      for (const rt of conns.values()) {
        closeConn(rt, 1000, "server shutdown");
        // Graceful close can stall on paused sockets (rate-limited connections): the
        // close handshake needs reads we have paused. Terminate so shutdown is prompt.
        try {
          rt.ws.terminate();
        } catch {
          // already gone
        }
        conns.delete(connKeyOf(rt.conn));
      }
      await router.close();
      // Force lingering keep-alive sockets closed so close() resolves promptly (doc 05
      // drains clients first in production; tests may leave peers half-open).
      closeAll(server);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (adminServer !== undefined) {
        closeAll(adminServer);
        await new Promise<void>((resolve) => adminServer?.close(() => resolve()));
      }
    },
  };
}

function closeAll(server: Server): void {
  const withConnections = server as Server & { closeAllConnections?: () => void };
  withConnections.closeAllConnections?.();
}
