/**
 * A SocketHost test double that records every callback with a global sequence number, so
 * suites can assert ordering ("notice before data") and exact fan-out.
 */

import { type ConnRef, decodeRelayFrame, type Notice, type SocketHost } from "@cairn/core";

export type RecordedEvent =
  | { seq: number; kind: "deliver"; conn: ConnRef; frame: Uint8Array }
  | { seq: number; kind: "notify"; conn: ConnRef; notice: Notice }
  | { seq: number; kind: "close"; conn: ConnRef; code: number; reason: string };

export class RecordingHost implements SocketHost {
  readonly hostId: string;
  readonly caps = { canPauseReads: true, serverPings: true, region: "test" };
  readonly events: RecordedEvent[] = [];
  private seq = 0;

  constructor(hostId = "test-host") {
    this.hostId = hostId;
  }

  deliver(conn: ConnRef, frame: Uint8Array): void {
    this.events.push({ seq: ++this.seq, kind: "deliver", conn, frame });
  }

  notify(conn: ConnRef, notice: Notice): void {
    this.events.push({ seq: ++this.seq, kind: "notify", conn, notice });
  }

  close(conn: ConnRef, code: number, reason: string): void {
    this.events.push({ seq: ++this.seq, kind: "close", conn, code, reason });
  }

  /** Events for one connection, in order. */
  forConn(conn: ConnRef): RecordedEvent[] {
    return this.events.filter((e) => e.conn.id === conn.id && e.conn.host === conn.host);
  }

  deliversTo(conn: ConnRef): Uint8Array[] {
    return this.forConn(conn)
      .filter((e): e is Extract<RecordedEvent, { kind: "deliver" }> => e.kind === "deliver")
      .map((e) => e.frame);
  }

  noticesTo(conn: ConnRef): Notice[] {
    return this.forConn(conn)
      .filter((e): e is Extract<RecordedEvent, { kind: "notify" }> => e.kind === "notify")
      .map((e) => e.notice);
  }

  /** All PeerGone frames delivered anywhere, decoded. */
  peerGones(): { peer: Uint8Array; seq: number }[] {
    const out: { peer: Uint8Array; seq: number }[] = [];
    for (const e of this.events) {
      if (e.kind !== "deliver") continue;
      const decoded = decodeRelayFrame(e.frame);
      if (decoded.type === "peerGone") out.push({ peer: decoded.peer, seq: e.seq });
    }
    return out;
  }
}
