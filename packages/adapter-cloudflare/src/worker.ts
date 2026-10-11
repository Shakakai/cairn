/**
 * The Cairn Edge Worker (docs/04): client WebSockets terminate here at the nearest PoP.
 * The Worker is the SocketHost; one Mailbox Durable Object per EndpointId is the Router.
 * All Worker↔DO sockets are opened by Workers (ADR-002); pings never reach a DO.
 */

import {
  type ConnRef,
  type ConnState,
  defaultRelayConfig,
  type Effect,
  type Env,
  type Notice,
  negotiateUpgrade,
  openConnection,
  type RelayConfig,
  routeHttp,
  step,
  type UpgradeDecision,
  validateRelayConfig,
} from "@cairn/core";
import { Mailbox } from "./mailbox.js";
import type { Env as Bindings } from "./types.js";

// ---------------------------------------------------------------------------
// Isolate-local state (docs/04). All sockets accepted by this isolate are handled here.
// ---------------------------------------------------------------------------

interface BufferedEvent {
  kind: "deliver" | "notice";
  frame?: Uint8Array;
  notice?: Notice;
}

interface ConnEntry {
  ws: WebSocket;
  conn: ConnRef;
  /** The upgrade request's execution context: async continuations must stay bound to a
   * request context or the platform rejects I/O ("on behalf of a different request"). */
  executionCtx: ExecutionContext;
  state: ConnState;
  queued: Promise<void>;
  nonce: Uint8Array;
  owner: WebSocket | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  registering: boolean;
  buffered: BufferedEvent[];
  /** Per-connection outbound frame window (cf.maxOutboundFramesPerSec). */
  sendCount: number;
  sendWindowStartMs: number;
  closed: boolean;
}

const local = new Map<string, ConnEntry>();
const activeByEndpoint = new Map<string, string>(); // EndpointId -> connKey

// Owner-socket keepalive (ADR-016): the platform reaps idle Worker→DO WebSockets after
// roughly a minute; a dead owner socket kills the client connection ("mailbox lost").
// Worker→DO pings are free and do not wake hibernated objects (docs/04 billing facts).
// Links are intentionally NOT pinged: they idle-close and reopen on demand, which keeps
// idle Durable Objects hibernated. Timers may not be created at module scope, so the
// interval starts lazily on the first request.
let ownerKeepalive: ReturnType<typeof setInterval> | undefined;
function ensureOwnerKeepalive(): void {
  if (ownerKeepalive !== undefined) return;
  ownerKeepalive = setInterval(() => {
    for (const entry of local.values()) {
      if (entry.closed || entry.owner === undefined) continue;
      const owner = entry.owner as WebSocket & { ping?: () => void };
      if (typeof owner.ping !== "function") continue;
      try {
        owner.ping();
      } catch {
        // closing
      }
    }
  }, 25_000);
}
let links: LinkCache | undefined;
const linkCache = (): LinkCache => {
  links ??= new LinkCache();
  return links;
};

const connKeyOf = (c: ConnRef): string => `${c.host}|${c.id}`;

/** WebSocket binary payloads arrive as ArrayBuffer, ArrayBufferView or Blob depending on
 * the runtime; normalise to bytes. */
async function toBytes(data: unknown): Promise<Uint8Array> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  return new Uint8Array(0);
}

let configCache: { raw: string; config: RelayConfig } | undefined;

function relayConfig(env: Bindings): RelayConfig {
  const raw = env.RELAY_CONFIG ?? "{}";
  if (configCache?.raw === raw) return configCache.config;
  const config = validateRelayConfig(JSON.parse(raw));
  configCache = { raw, config };
  return config;
}

function makeEnv(env: Bindings, request: Request): Env {
  const config = relayConfig(env);
  const cf = (request as unknown as { cf?: { colo?: string } }).cf;
  return {
    nowMs: Date.now(),
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
    config,
    caps: {
      canPauseReads: false, // Workers: drop instead of pausing (docs/02)
      serverPings: false, // the platform answers client pings
      region: cf?.colo ?? "",
    },
  };
}

// ---------------------------------------------------------------------------
// Effect execution (docs/04).
// ---------------------------------------------------------------------------

function runEffects(entry: ConnEntry, effects: Effect[], env: Env, bindings: Bindings): void {
  for (const effect of effects) execEffect(entry, effect, env, bindings);
}

function execEffect(entry: ConnEntry, effect: Effect, env: Env, bindings: Bindings): void {
  const config = env.config;
  switch (effect.kind) {
    case "send": {
      const now = Date.now();
      if (now - entry.sendWindowStartMs >= 1000) {
        entry.sendWindowStartMs = now;
        entry.sendCount = 0;
      }
      if (entry.sendCount >= config.cf.maxOutboundFramesPerSec) {
        metric(bindings, "relay_frames_dropped_total", 1, { reason: "rate_limited_out" });
        return;
      }
      entry.sendCount += 1;
      try {
        entry.ws.send(effect.bytes);
      } catch {
        // closed mid-send
      }
      break;
    }
    case "close": {
      closeEntry(entry, effect.code, effect.reason);
      enqueue(entry, { kind: "socketClosed" }, env, bindings);
      break;
    }
    case "timer": {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.timer = setTimeout(
        () => enqueue(entry, { kind: "timer" }, env, bindings),
        Math.max(0, effect.atMs - Date.now()),
      );
      break;
    }
    case "register": {
      entry.registering = true;
      void registerWithMailbox(entry, effect.endpoint, env, bindings);
      break;
    }
    case "unregister": {
      const key = activeByEndpoint.get(effect.endpoint);
      if (key === connKeyOf(entry.conn)) {
        activeByEndpoint.delete(effect.endpoint);
      }
      if (entry.owner !== undefined) {
        try {
          entry.owner.send(JSON.stringify({ t: "bye", sentTo: effect.sentTo }));
          entry.owner.close(1000, "bye");
        } catch {
          // already closed
        }
      }
      break;
    }
    case "route": {
      // ADR-015: the platform rejects sending on a WebSocket owned by a different
      // upgrade request ("Cannot perform I/O on behalf of a different request"), so the
      // isolate-local fast path of docs/04 cannot work on current Workers. Every frame
      // travels the documented link path: Worker → destination mailbox → owner socket →
      // this Worker (the owner-socket message event is a legal context for the final
      // client send, as are registry notices).
      void entry.executionCtx.waitUntil(linkCache().send(effect.dst, effect.frame, bindings, metric));
      break;
    }
    case "pauseReads":
    case "resumeReads":
      // Workers cannot pause reads (caps.canPauseReads = false); the core never emits
      // these on this platform.
      break;
    case "metric": {
      metric(bindings, effect.name, effect.value ?? 1, effect.labels);
      break;
    }
  }
}

function metric(bindings: Bindings, name: string, value: number, labels?: Record<string, string>): void {
  const config = relayConfig(bindings);
  if (bindings.METRICS === undefined || Math.random() > config.metrics.sampleRate) {
    return;
  }
  try {
    bindings.METRICS.writeDataPoint({
      blobs: [name, ...(labels ? Object.values(labels) : [])],
      doubles: [value],
    });
  } catch {
    // metrics must never break the relay
  }
}

async function registerWithMailbox(
  entry: ConnEntry,
  endpoint: string,
  env: Env,
  bindings: Bindings,
): Promise<void> {
  // Transient DO wake failures ("Network connection lost" while a mailbox evicts) retry
  // with backoff; a 409 replay verdict is final.
  let response: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const stub = bindings.MAILBOX.get(bindings.MAILBOX.idFromName(endpoint));
    try {
      response = await stub.fetch("https://mailbox/owner", {
        headers: {
          Upgrade: "websocket",
          "x-conn": connKeyOf(entry.conn),
          "x-nonce": b64encode(entry.nonce),
          "x-nonce-ttl": String(2 * env.config.authSkewMs),
        },
      });
      break;
    } catch (error) {
      if (attempt === 2) throw error;
      console.log(JSON.stringify({ msg: "owner open retry", attempt, error: String(error) }));
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  if (response === undefined) {
    closeEntry(entry, 1011, "mailbox unavailable");
    return;
  }
  try {
    if (response.status === 409) {
      closeEntry(entry, 1008, "auth replay");
      return;
    }
    if (response.status !== 101 || response.webSocket === null) {
      closeEntry(entry, 1011, "mailbox unavailable");
      return;
    }
    const owner = response.webSocket;
    entry.owner = owner;
    owner.accept();
    owner.addEventListener("message", (ev: MessageEvent) => {
      if (typeof ev.data === "string") {
        const notice = (JSON.parse(ev.data as string) as { n?: Notice }).n;
        if (notice !== undefined) {
          trackActive(entry, endpoint, notice);
          enqueue(entry, { kind: "registryNotice", notice }, env, bindings);
        }
      } else {
        void toBytes(ev.data).then((bytes) => {
          enqueue(entry, { kind: "deliver", frame: bytes }, env, bindings);
        });
      }
    });
    owner.addEventListener("close", () => {
      closeEntry(entry, 1012, "mailbox lost");
    });
    // Ready handshake (ADR-015): the mailbox buffers notices/frames for this owner until
    // it sees `ready`; everything after is plain in-order delivery.
    try {
      owner.send(JSON.stringify({ t: "ready" }));
    } catch {
      // closing
    }
    entry.registering = false;
    enqueue(entry, { kind: "registered" }, env, bindings);
    flushBuffered(entry, env, bindings);
  } catch (error) {
    console.log(JSON.stringify({ msg: "owner socket failed", error: String(error) }));
    closeEntry(entry, 1011, "mailbox lost");
  }
}

function trackActive(entry: ConnEntry, endpoint: string, notice: Notice): void {
  const key = connKeyOf(entry.conn);
  if (notice === "becameInactive") {
    if (activeByEndpoint.get(endpoint) === key) activeByEndpoint.delete(endpoint);
  } else {
    activeByEndpoint.set(endpoint, key);
  }
}

function bufferEvent(entry: ConnEntry, event: BufferedEvent, bindings: Bindings): void {
  if (entry.buffered.length >= relayConfig(bindings).registeringBufferFrames) {
    metric(bindings, "relay_frames_dropped_total", 1, { reason: "registering_buffer_full" });
    return;
  }
  entry.buffered.push(event);
}

function flushBuffered(entry: ConnEntry, env: Env, bindings: Bindings): void {
  const notices = entry.buffered.filter((e) => e.kind === "notice");
  const delivers = entry.buffered.filter((e) => e.kind === "deliver");
  entry.buffered = [];
  for (const e of notices) {
    enqueue(entry, { kind: "registryNotice", notice: e.notice as Notice }, env, bindings);
  }
  for (const e of delivers) {
    enqueue(entry, { kind: "deliver", frame: e.frame as Uint8Array }, env, bindings);
  }
}

function enqueue(entry: ConnEntry, ev: Parameters<typeof step>[1], env: Env, bindings: Bindings): void {
  entry.queued = entry.queued.then(() => {
    if (entry.closed && ev.kind !== "socketClosed") return;
    const { state, effects } = step(entry.state, ev, env);
    entry.state = state;
    runEffects(entry, effects, env, bindings);
  });
  entry.queued = entry.queued.catch((error: unknown) => {
    console.log(JSON.stringify({ msg: "connection step failed", error: String(error) }));
    closeEntry(entry, 1011, "internal error");
  });
}

function closeEntry(entry: ConnEntry, code: number, reason: string): void {
  if (entry.closed) return;
  entry.closed = true;
  if (entry.timer !== undefined) clearTimeout(entry.timer);
  try {
    entry.ws.close(code, reason);
  } catch {
    // already closed
  }
}

// ---------------------------------------------------------------------------
// Link cache (docs/04): one Worker→mailbox socket per destination per isolate.
// ---------------------------------------------------------------------------

interface LinkEntry {
  ws: WebSocket;
  idleTimer: ReturnType<typeof setTimeout>;
}

class LinkCache {
  private readonly byEndpoint = new Map<string, LinkEntry>();
  private readonly opening = new Map<string, Promise<void>>();
  private readonly queues = new Map<string, { frame: Uint8Array; queuedAt: number }[]>();
  private readonly lastUsed = new Map<string, number>();
  private readonly newDestinations = new Map<string, { count: number; windowStart: number }>();

  async send(dst: string, frame: Uint8Array, bindings: Bindings, metricFn: typeof metric): Promise<void> {
    const existing = this.byEndpoint.get(dst);
    if (existing !== undefined) {
      this.touch(dst);
      try {
        existing.ws.send(frame);
        return;
      } catch {
        this.byEndpoint.delete(dst);
      }
    }

    // Queue while opening (cap 64 frames / 2s, docs/04).
    const queue = this.queues.get(dst) ?? [];
    if (queue.length >= 64) {
      metricFn(bindings, "relay_frames_dropped_total", 1, { reason: "link_opening" });
      return;
    }
    queue.push({ frame, queuedAt: Date.now() });
    this.queues.set(dst, queue);
    void this.open(dst, bindings, metricFn);
  }

  private async open(dst: string, bindings: Bindings, metricFn: typeof metric): Promise<void> {
    if (this.opening.has(dst)) return;
    this.opening.set(dst, this.doOpen(dst, bindings, metricFn));
    try {
      await this.opening.get(dst);
    } finally {
      this.opening.delete(dst);
    }
  }

  private async doOpen(dst: string, bindings: Bindings, metricFn: typeof metric): Promise<void> {
    const config = relayConfig(bindings);
    // Abuse cap: opening a link creates a Durable Object (docs/04).
    const window = this.newDestinations.get(dst) ?? { count: 0, windowStart: 0 };
    const now = Date.now();
    if (now - window.windowStart >= 60_000) {
      window.count = 0;
      window.windowStart = now;
    }
    if (window.count >= config.maxNewDestinationsPerMinute) {
      metricFn(bindings, "relay_frames_dropped_total", 1, { reason: "new_dest_cap" });
      this.queues.delete(dst);
      return;
    }
    window.count += 1;
    this.newDestinations.set(dst, window);

    const stub = bindings.MAILBOX.get(bindings.MAILBOX.idFromName(dst));
    let response: Response;
    try {
      response = await stub.fetch("https://mailbox/link", { headers: { Upgrade: "websocket" } });
    } catch (error) {
      metricFn(bindings, "relay_router_errors_total", 1, { kind: "link_open" });
      this.queues.delete(dst);
      return;
    }
    if (response.status !== 101 || response.webSocket === null) {
      this.queues.delete(dst);
      return;
    }
    const ws = response.webSocket;
    ws.accept();
    ws.addEventListener("close", () => {
      this.byEndpoint.delete(dst);
    });

    const entry: LinkEntry = {
      ws,
      idleTimer: setTimeout(() => this.closeIdle(dst, config.cf.linkIdleMs), config.cf.linkIdleMs),
    };
    this.byEndpoint.set(dst, entry);
    this.touch(dst);
    this.evictIfNeeded(bindings, config.cf.maxLinksPerIsolate);

    // Flush the opening queue, dropping frames older than 2s.
    const queue = this.queues.get(dst) ?? [];
    this.queues.delete(dst);
    for (const { frame, queuedAt } of queue) {
      if (Date.now() - queuedAt > 2_000) {
        metricFn(bindings, "relay_frames_dropped_total", 1, { reason: "link_opening" });
        continue;
      }
      try {
        ws.send(frame);
      } catch {
        break;
      }
    }
  }

  private touch(dst: string): void {
    this.lastUsed.delete(dst);
    this.lastUsed.set(dst, Date.now());
    const entry = this.byEndpoint.get(dst);
    if (entry !== undefined) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = setTimeout(
        () => this.closeIdle(dst, relayConfigFromCache().cf.linkIdleMs),
        relayConfigFromCache().cf.linkIdleMs,
      );
    }
  }

  private closeIdle(dst: string, _idleMs: number): void {
    const entry = this.byEndpoint.get(dst);
    if (entry === undefined) return;
    this.byEndpoint.delete(dst);
    this.lastUsed.delete(dst);
    try {
      entry.ws.close(1000, "idle");
    } catch {
      // already closed
    }
  }

  private evictIfNeeded(bindings: Bindings, max: number): void {
    while (this.byEndpoint.size > max) {
      const oldest = this.lastUsed.keys().next().value;
      if (oldest === undefined) break;
      this.closeIdle(oldest, 0);
      void bindings;
    }
  }
}

// The config cache is process-wide in the isolate; used by idle timers without plumbing.
function relayConfigFromCache(): RelayConfig {
  return configCache?.config ?? defaultRelayConfig;
}

// ---------------------------------------------------------------------------
// fetch: HTTP surface + upgrade (docs/01 §2, doc 04).
// ---------------------------------------------------------------------------

const draining = false;

export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    ensureOwnerKeepalive();
    const url = new URL(request.url);
    const coreEnv = makeEnv(env, request);

    if (url.pathname === "/v1/connect") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return jsonError(400, "expected websocket upgrade");
      }
      if (draining) {
        return jsonError(503, "draining", { "Retry-After": "1" });
      }
      const decision = negotiateUpgrade(
        {
          method: request.method,
          path: url.pathname,
          headers: lowerCaseHeaders(request.headers),
          query: (() => {
            const q: Record<string, string> = {};
            url.searchParams.forEach((value, name) => {
              q[name] = value;
            });
            return q;
          })(),
        },
        coreEnv,
      );
      if (!decision.ok) {
        return new Response(decision.body, { status: decision.status, headers: decision.headers });
      }
      return acceptWebSocket(request, ctx, decision, coreEnv, env);
    }

    if (url.pathname === "/healthz" && url.searchParams.has("ready")) {
      return new Response(JSON.stringify({ status: draining ? "draining" : "ok" }), {
        status: draining ? 503 : 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const response = routeHttp(
      {
        method: request.method,
        path: url.pathname,
        headers: lowerCaseHeaders(request.headers),
      },
      { version: "0.0.0", commit: env.GIT_COMMIT ?? "dev" },
    );
    return new Response(response.body, {
      status: response.status,
      ...(response.headers !== undefined ? { headers: response.headers } : {}),
    });
  },
};

function acceptWebSocket(
  request: Request,
  executionCtx: ExecutionContext,
  decision: Extract<UpgradeDecision, { ok: true }>,
  coreEnv: Env,
  bindings: Bindings,
): Response {
  const pair = new WebSocketPair();
  const server = pair[1];
  server.accept();

  const conn: ConnRef = { host: "cf", id: crypto.randomUUID() };
  const entry: ConnEntry = {
    ws: server,
    conn,
    executionCtx,
    state: undefined as unknown as ConnState,
    queued: Promise.resolve(),
    nonce: decision.nonce,
    owner: undefined,
    timer: undefined,
    registering: false,
    buffered: [],
    sendCount: 0,
    sendWindowStartMs: 0,
    closed: false,
  };
  local.set(connKeyOf(conn), entry);

  const opened = openConnection({ conn, decision }, coreEnv);
  entry.state = opened.state;
  runEffects(entry, opened.effects, coreEnv, bindings);

  server.addEventListener("message", (ev: MessageEvent) => {
    if (typeof ev.data === "string") {
      enqueue(entry, { kind: "textMessage" }, coreEnv, bindings);
      return;
    }
    void entry.executionCtx.waitUntil(
      toBytes(ev.data).then((bytes) => {
        enqueue(entry, { kind: "frame", bytes }, coreEnv, bindings);
      }),
    );
  });
  server.addEventListener("close", () => {
    local.delete(connKeyOf(conn));
    enqueue(entry, { kind: "socketClosed" }, coreEnv, bindings);
  });
  server.addEventListener("error", () => {
    closeEntry(entry, 1011, "socket error");
  });

  return new Response(null, {
    status: 101,
    webSocket: pair[0],
    headers: { "Sec-WebSocket-Protocol": "switchback.v1" },
  });
}

function lowerCaseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    out[name.toLowerCase()] = value;
  });
  return out;
}

function jsonError(status: number, body: string, headers?: Record<string, string>): Response {
  return new Response(body, { status, ...(headers !== undefined ? { headers } : {}) });
}

function b64encode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

// Re-export for wrangler.jsonc bindings and tests.
export { Mailbox };
