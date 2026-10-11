/**
 * The Mailbox Durable Object (docs/04): one per EndpointId, owns the registry semantics
 * for that endpoint (newest wins, promotion, PeerGone fan-out, connection cap, nonce
 * replay) and routes frames from link sockets to the active owner.
 *
 * Transport note (ADR-015): sockets use the classic `accept()` + event-listener model.
 * The Hibernation API (`ctx.acceptWebSocket` + `webSocketMessage`) is the documented
 * end-state (hibernation-eligible objects are not duration-billed) but socket events did
 * not wake the object under the local runtime used for conformance, so the classic model
 * ships first; attachments are still maintained so the state-rebuild path is ready when
 * hibernation is re-enabled on real infrastructure.
 *
 * Delivery note: notices and frames destined for a freshly accepted owner socket are
 * buffered until the peer sends `{"t":"ready"}` on that socket. This closes the race
 * where the Worker/Router attaches its message listener only after the 101 response, and
 * messages sent before that would be dropped (socket events do not buffer for late
 * listeners). Everything after `ready` is plain in-order socket delivery.
 */

import { DurableObject } from "cloudflare:workers";
import { endpointIdToBytes } from "@cairn/core";
import type { Env } from "./types.js";

const NONCE_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS nonces (
    nonce BLOB PRIMARY KEY,
    expires_ms INTEGER NOT NULL
  );
`;

export interface OwnerAttachment {
  conn: string;
  role: "active" | "inactive";
  deactivatedAt?: number;
  ready: boolean;
}

type NoticeName = "becameActive" | "becameInactive" | "promoted";

const SENT_TO_KEY = "sentTo";

export class Mailbox extends DurableObject<Env> {
  /**
   * Notices/binary buffered for owners that have not sent `ready` yet. Keyed by conn
   * key (attachments), so it survives hibernation rebuilds.
   */
  private readonly pending = new Map<string, { notices: NoticeName[]; frames: Uint8Array[] }>();
  /** Sent-to set reported by a `bye`, held until the close event. */
  private readonly pendingSentTo = new Map<string, string[]>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  // -------------------------------------------------------------------------
  // HTTP surface: /owner (Worker holding a client conn), /link (any isolate).
  // -------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/owner") return this.handleOwner(request);
    if (url.pathname === "/link") return this.handleLink(request);
    return new Response("not found", { status: 404 });
  }

  private handleOwner(request: Request): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket upgrade", { status: 400 });
    }
    const conn = request.headers.get("x-conn");
    if (conn === null) {
      return new Response("missing x-conn", { status: 400 });
    }

    // Nonce replay check, scoped to this endpoint's mailbox (docs/01 §3.2 check 5).
    const nonceHeader = request.headers.get("x-nonce");
    if (nonceHeader !== null) {
      const nonce = b64decode(nonceHeader);
      const ttlMs = Number(request.headers.get("x-nonce-ttl") ?? "120000");
      if (!this.claimNonce(nonce, ttlMs)) {
        return new Response("auth replay", { status: 409 });
      }
    }

    const pair = new WebSocketPair();
    const server = pair[1];
    // Hibernation API (docs/04): the platform may evict and rebuild this object; all
    // registry state lives in attachments, sockets are enumerated via getWebSockets().
    this.ctx.acceptWebSocket(server);
    const attachment: OwnerAttachment = { conn, role: "active", ready: false };
    server.serializeAttachment(attachment);
    this.applyRegister(server, attachment);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private handleLink(request: Request): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket upgrade", { status: 400 });
    }
    const pair = new WebSocketPair();
    const server = pair[1];
    // Links are anonymous forwarders; no attachment.
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string") {
      const attachment = ws.deserializeAttachment() as OwnerAttachment | null;
      if (attachment !== null) {
        this.handleOwnerText(ws, attachment, message);
      }
      return;
    }
    const raw: unknown = message;
    let bytes: Uint8Array;
    if (raw instanceof ArrayBuffer) {
      bytes = new Uint8Array(raw);
    } else if (ArrayBuffer.isView(raw)) {
      bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    } else if (raw instanceof Blob) {
      bytes = new Uint8Array(await raw.arrayBuffer());
    } else {
      bytes = new Uint8Array(0);
    }
    this.forwardToActive(bytes);
  }

  override async webSocketClose(ws: WebSocket, _code: number, _reason: string): Promise<void> {
    const attachment = ws.deserializeAttachment() as OwnerAttachment | null;
    if (attachment === null) return; // a link: nothing to do (docs/04)
    const conn = attachment.conn;
    const byeSentTo = this.pendingSentTo.get(conn) ?? [];
    this.pending.delete(conn);
    this.pendingSentTo.delete(conn);
    await this.applyUnregister(attachment, byeSentTo);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as OwnerAttachment | null;
    if (attachment === null) return;
    const conn = attachment.conn;
    const byeSentTo = this.pendingSentTo.get(conn) ?? [];
    this.pending.delete(conn);
    this.pendingSentTo.delete(conn);
    await this.applyUnregister(attachment, byeSentTo);
  }

  private handleOwnerText(server: WebSocket, attachment: OwnerAttachment, text: string): void {
    let parsed: { t?: string; sentTo?: unknown; n?: NoticeName };
    try {
      parsed = JSON.parse(text) as { t?: string; sentTo?: unknown; n?: NoticeName };
    } catch {
      return;
    }
    if (parsed.t === "ready") {
      attachment.ready = true;
      server.serializeAttachment(attachment);
      const buffered = this.pending.get(attachment.conn);
      if (buffered !== undefined) {
        this.pending.delete(attachment.conn);
        for (const notice of buffered.notices) {
          this.sendText(server, JSON.stringify({ n: notice }));
        }
        for (const frame of buffered.frames) {
          this.sendBinary(server, frame);
        }
      }
      return;
    }
    if (parsed.t === "bye" && Array.isArray(parsed.sentTo)) {
      this.pendingSentTo.set(
        attachment.conn,
        parsed.sentTo.filter((x): x is string => typeof x === "string"),
      );
    }
  }

  // -------------------------------------------------------------------------
  // DO RPC: PeerGone fan-out target (docs/04).
  // -------------------------------------------------------------------------

  async deliverControl(frame: Uint8Array): Promise<void> {
    this.forwardToActive(new Uint8Array(frame));
  }

  /** Test-only: nonce claim through the same table as /owner. */
  claimNonceForTests(nonce: number[], ttlMs: number): boolean {
    return this.claimNonce(new Uint8Array(nonce), ttlMs);
  }

  /** Test-only: reset all state. */
  async __resetForTests(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, "reset");
      } catch {
        // ignore
      }
    }
    this.pending.clear();
    this.pendingSentTo.clear();
    await this.ctx.storage.deleteAll();
  }

  // -------------------------------------------------------------------------
  // Registry rules (docs/02 registry.ts, realised here for one endpoint).
  // -------------------------------------------------------------------------

  private owners(): { ws: WebSocket; attachment: OwnerAttachment }[] {
    const out: { ws: WebSocket; attachment: OwnerAttachment }[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as OwnerAttachment | null;
      if (attachment !== null) {
        out.push({ ws, attachment });
      }
    }
    return out;
  }

  private activeOwner(): { ws: WebSocket; attachment: OwnerAttachment } | undefined {
    return this.owners().find((o) => o.attachment.role === "active");
  }

  private sendNotice(ws: WebSocket, attachment: OwnerAttachment, notice: NoticeName): void {
    if (!attachment.ready) {
      const buffered = this.pending.get(attachment.conn) ?? { notices: [], frames: [] };
      buffered.notices.push(notice);
      this.pending.set(attachment.conn, buffered);
      return;
    }
    this.sendText(ws, JSON.stringify({ n: notice }));
  }

  private sendText(ws: WebSocket, text: string): void {
    try {
      ws.send(text);
    } catch {
      // closing
    }
  }

  private sendBinary(ws: WebSocket, frame: Uint8Array): void {
    try {
      ws.send(frame);
    } catch {
      // closing
    }
  }

  /** Route a frame to the active owner, buffering until `ready` if needed. */
  private forwardToActive(frame: Uint8Array): void {
    const active = this.activeOwner();
    if (active === undefined) {
      return; // drop + metric on the sending side (docs/04)
    }
    if (!active.attachment.ready) {
      const buffered = this.pending.get(active.attachment.conn) ?? { notices: [], frames: [] };
      buffered.frames.push(frame);
      this.pending.set(active.attachment.conn, buffered);
      return;
    }
    this.sendBinary(active.ws, frame);
  }

  private applyRegister(newcomerWs: WebSocket, newcomer: OwnerAttachment): void {
    // The newcomer is already visible via getWebSockets(); exclude it when looking for
    // the previous active connection.
    const previousActive = this.owners().find((o) => o.attachment.role === "active" && o.ws !== newcomerWs);
    if (previousActive !== undefined && previousActive.ws !== newcomerWs) {
      previousActive.attachment.role = "inactive";
      previousActive.attachment.deactivatedAt = Date.now();
      previousActive.ws.serializeAttachment(previousActive.attachment);
      this.sendNotice(previousActive.ws, previousActive.attachment, "becameInactive");
    }
    this.sendNotice(newcomerWs, newcomer, "becameActive");

    // Cap: active + inactive must not exceed maxConnectionsPerEndpoint; evict the oldest
    // inactive with 1008 (docs/01 §5.1).
    const max = 4;
    for (;;) {
      const all = this.owners();
      if (all.length <= max) break;
      const oldest = all
        .filter((o) => o.attachment.role === "inactive")
        .sort((a, b) => (a.attachment.deactivatedAt ?? 0) - (b.attachment.deactivatedAt ?? 0))[0];
      if (oldest === undefined) break;
      try {
        oldest.ws.close(1008, "too many connections for endpoint");
      } catch {
        // already closing
      }
    }
  }

  private async applyUnregister(attachment: OwnerAttachment, byeSentTo: string[]): Promise<void> {
    const stored = await this.readSentTo();
    const merged = mergeBounded(byeSentTo, stored, 4096);

    const remaining = this.owners().filter((o) => o.attachment.conn !== attachment.conn);
    const isActive =
      attachment.role === "active" &&
      (this.activeOwner()?.attachment.conn === attachment.conn ||
        remaining.every((o) => o.attachment.conn !== attachment.conn));

    if (!isActive) {
      if (merged.length > 0) await this.writeSentTo(merged);
      return;
    }

    const inactive = remaining
      .filter((o) => o.attachment.role === "inactive")
      .sort((a, b) => (a.attachment.deactivatedAt ?? 0) - (b.attachment.deactivatedAt ?? 0));
    const promoted = inactive.at(-1);
    if (promoted !== undefined) {
      promoted.attachment.role = "active";
      delete promoted.attachment.deactivatedAt;
      promoted.ws.serializeAttachment(promoted.attachment);
      this.sendNotice(promoted.ws, promoted.attachment, "promoted");
      if (merged.length > 0) await this.writeSentTo(merged);
      return;
    }

    // Fully gone: fan out PeerGone to the sent-to union, best-effort (docs/01 §5.3).
    await this.ctx.storage.delete(SENT_TO_KEY);
    if (merged.length > 0) {
      const frame = peerGoneFrame(this.ownEndpointBytes());
      const namespace = this.env.MAILBOX;
      this.ctx.waitUntil(
        (async () => {
          for (const target of merged) {
            try {
              const stub = namespace.get(namespace.idFromName(target)) as unknown as {
                deliverControl(frame: Uint8Array): Promise<void>;
              };
              await stub.deliverControl(frame);
            } catch {
              // best-effort (docs/04)
            }
          }
        })(),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Nonce replay cache (docs/04): SQLite table in the mailbox's storage.
  // -------------------------------------------------------------------------

  private claimNonce(nonce: Uint8Array, ttlMs: number): boolean {
    const sql = this.ctx.storage.sql;
    sql.exec(NONCE_TABLE_DDL);
    const now = Date.now();
    sql.exec("DELETE FROM nonces WHERE expires_ms <= ?", now);
    const hex = toHex(nonce);
    const existing = sql.exec(`SELECT expires_ms FROM nonces WHERE nonce = x'${hex}'`).toArray();
    const row = existing[0] as { expires_ms: number } | undefined;
    if (row !== undefined) {
      if (row.expires_ms > now) {
        return false;
      }
      sql.exec(`DELETE FROM nonces WHERE nonce = x'${hex}'`);
    }
    sql.exec(`INSERT INTO nonces (nonce, expires_ms) VALUES (x'${hex}', ?)`, now + ttlMs);
    return true;
  }

  // -------------------------------------------------------------------------
  // Persisted sent-to union (rare: only while other owners remain, docs/04).
  // -------------------------------------------------------------------------

  private async readSentTo(): Promise<string[]> {
    const value = await this.ctx.storage.get<string>(SENT_TO_KEY);
    if (typeof value !== "string") return [];
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  private async writeSentTo(sentTo: string[]): Promise<void> {
    await this.ctx.storage.put(SENT_TO_KEY, JSON.stringify(sentTo.slice(0, 4096)));
  }

  /** This mailbox's EndpointId (the DO name) as key bytes, for PeerGone frames. */
  private ownEndpointBytes(): Uint8Array {
    const name = this.ctx.id.name;
    if (name === undefined) {
      return new Uint8Array(32);
    }
    try {
      return endpointIdToBytes(name);
    } catch {
      return new Uint8Array(32);
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function peerGoneFrame(endpointIdBytes: Uint8Array): Uint8Array {
  const frame = new Uint8Array(1 + 32);
  frame[0] = 0x06; // PeerGone
  frame.set(endpointIdBytes, 1);
  return frame;
}

function mergeBounded(reported: string[], existing: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...reported, ...existing]) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

function b64decode(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
