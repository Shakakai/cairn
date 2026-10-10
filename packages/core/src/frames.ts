/**
 * Frame codec for Switchback v1 (doc 01 §4): the eight binary frame types, client-frame
 * validation with close codes, and the relay's byte-rewriting forward transform.
 */

import { isValidEndpointKey } from "./keys.js";

export const FrameType = {
  ServerInfo: 0x01,
  Send: 0x02,
  SendBatch: 0x03,
  Recv: 0x04,
  RecvBatch: 0x05,
  PeerGone: 0x06,
  Status: 0x07,
  Restarting: 0x08,
} as const;

/** Largest Send/SendBatch payload the relay accepts (doc 01 §9). */
export const MAX_FRAME_PAYLOAD = 65_536;
/** Largest WebSocket message; enforced by adapters at the socket layer (doc 01 §9). */
export const MAX_WEBSOCKET_MESSAGE = 1 << 20;

/** Frame decode failure carrying the WebSocket close code (doc 01 §8). */
export class FrameError extends Error {
  constructor(
    readonly code: 1002 | 1009,
    reason: string,
  ) {
    super(reason);
    this.name = "FrameError";
  }
}

const protocolError = (reason: string): FrameError => new FrameError(1002, reason);
const tooBigError = (reason: string): FrameError => new FrameError(1009, reason);

export type ClientFrame =
  | { type: "send"; dst: Uint8Array; ecn: 0 | 1 | 2 | 3; datagram: Uint8Array }
  | { type: "sendBatch"; dst: Uint8Array; ecn: 0 | 1 | 2 | 3; segmentSize: number; datagrams: Uint8Array };

export type RelayFrame =
  | { type: "serverInfo"; maxPayload: number; maxConnAgeS: number; region: string; connId: string }
  | { type: "recv"; src: Uint8Array; ecn: number; datagram: Uint8Array }
  | { type: "recvBatch"; src: Uint8Array; ecn: number; segmentSize: number; datagrams: Uint8Array }
  | { type: "peerGone"; peer: Uint8Array }
  | { type: "status"; code: number }
  | { type: "restarting"; reconnectInMs: number; tryForMs: number }
  | { type: "unknown"; frameType: number };

function readEcn(payload: Uint8Array, offset: number): 0 | 1 | 2 | 3 {
  const ecn = payload[offset];
  if (ecn === undefined || ecn > 3) throw protocolError(`ecn must be 0..3, got ${ecn}`);
  return ecn as 0 | 1 | 2 | 3;
}

function readDst(payload: Uint8Array): Uint8Array {
  const dst = payload.subarray(0, 32);
  if (!isValidEndpointKey(dst)) throw protocolError("dst is not a valid Ed25519 key");
  return dst;
}

/**
 * Validate and decode a client→relay frame (doc 01 §4.1–4.2). Throws {@link FrameError} with
 * the close code the adapter must use.
 */
export function decodeClientFrame(bytes: Uint8Array): ClientFrame {
  if (bytes.length < 1) throw protocolError("empty frame");
  const frameType = bytes[0] as number;
  if (frameType !== FrameType.Send && frameType !== FrameType.SendBatch) {
    throw protocolError(`unexpected client frame type 0x${frameType.toString(16).padStart(2, "0")}`);
  }
  const payload = bytes.subarray(1);
  if (payload.length > MAX_FRAME_PAYLOAD) {
    throw tooBigError(`payload ${payload.length} bytes exceeds ${MAX_FRAME_PAYLOAD}`);
  }

  if (frameType === FrameType.Send) {
    if (payload.length < 33) throw protocolError("Send payload must be at least 33 bytes");
    return {
      type: "send",
      dst: readDst(payload),
      ecn: readEcn(payload, 32),
      datagram: payload.subarray(33),
    };
  }

  if (payload.length < 35) throw protocolError("SendBatch payload must be at least 35 bytes");
  const segmentSize = new DataView(payload.buffer, payload.byteOffset).getUint16(33);
  if (segmentSize < 1) throw protocolError("segment_size must be >= 1");
  return {
    type: "sendBatch",
    dst: readDst(payload),
    ecn: readEcn(payload, 32),
    segmentSize,
    datagrams: payload.subarray(35),
  };
}

/**
 * The relay's forwarding rewrite (doc 01 §4.3): `Send→Recv`, `SendBatch→RecvBatch`, dst key
 * replaced by the sender's key, contents copied exactly once into a fresh buffer.
 */
export function forwardTransform(bytes: Uint8Array, src: Uint8Array): Uint8Array {
  if (src.length !== 32) throw new Error("src key must be 32 bytes");
  const frame = decodeClientFrame(bytes); // validates fully; throws FrameError
  const out = new Uint8Array(bytes.length);
  out[0] = frame.type === "send" ? FrameType.Recv : FrameType.RecvBatch;
  out.set(src, 1);
  out.set(bytes.subarray(33), 33); // dst(32) + ecn(1) line up; type byte already rewritten
  return out;
}

// ---------------------------------------------------------------------------
// Relay → client encoding
// ---------------------------------------------------------------------------

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export const encode = {
  serverInfo(parts: { maxPayload: number; maxConnAgeS: number; region: string; connId: string }): Uint8Array {
    const region = utf8(parts.region);
    const connId = utf8(parts.connId);
    if (region.length > 255 || connId.length > 255) throw new Error("region/connId too long");
    const out = new Uint8Array(1 + 4 + 4 + 1 + region.length + 1 + connId.length);
    out[0] = FrameType.ServerInfo;
    const view = new DataView(out.buffer);
    view.setUint32(1, parts.maxPayload);
    view.setUint32(5, parts.maxConnAgeS);
    out[9] = region.length;
    out.set(region, 10);
    out[10 + region.length] = connId.length;
    out.set(connId, 11 + region.length);
    return out;
  },

  recv(parts: { src: Uint8Array; ecn: number; datagram: Uint8Array }): Uint8Array {
    const out = new Uint8Array(1 + 32 + 1 + parts.datagram.length);
    out[0] = FrameType.Recv;
    out.set(parts.src, 1);
    out[33] = parts.ecn & 0xff;
    out.set(parts.datagram, 34);
    return out;
  },

  recvBatch(parts: { src: Uint8Array; ecn: number; segmentSize: number; datagrams: Uint8Array }): Uint8Array {
    const out = new Uint8Array(1 + 32 + 1 + 2 + parts.datagrams.length);
    out[0] = FrameType.RecvBatch;
    out.set(parts.src, 1);
    out[33] = parts.ecn & 0xff;
    new DataView(out.buffer).setUint16(34, parts.segmentSize);
    out.set(parts.datagrams, 36);
    return out;
  },

  peerGone(peer: Uint8Array): Uint8Array {
    const out = new Uint8Array(1 + 32);
    out[0] = FrameType.PeerGone;
    out.set(peer, 1);
    return out;
  },

  status(code: number): Uint8Array {
    return new Uint8Array([FrameType.Status, code & 0xff]);
  },

  restarting(reconnectInMs: number, tryForMs: number): Uint8Array {
    const out = new Uint8Array(1 + 4 + 4);
    out[0] = FrameType.Restarting;
    const view = new DataView(out.buffer);
    view.setUint32(1, reconnectInMs);
    view.setUint32(5, tryForMs);
    return out;
  },
};

// ---------------------------------------------------------------------------
// Relay frame decoding (tests, tools; clients tolerate unknown types — doc 01 §1)
// ---------------------------------------------------------------------------

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset);
}

/**
 * Decode a relay→client frame. Unknown frame types decode to `{ type: "unknown" }` (clients
 * ignore them, doc 01 §1/§4.5); malformed known frames throw {@link FrameError} (1002).
 * ServerInfo trailing bytes are ignored (doc 01 §4.4).
 */
export function decodeRelayFrame(bytes: Uint8Array): RelayFrame {
  if (bytes.length < 1) throw protocolError("empty frame");
  const frameType = bytes[0] as number;
  const payload = bytes.subarray(1);
  const view = new DataView(bytes.buffer, bytes.byteOffset);

  switch (frameType) {
    case FrameType.ServerInfo: {
      if (payload.length < 9) throw protocolError("ServerInfo truncated");
      const maxPayload = readU32(view, 1);
      const maxConnAgeS = readU32(view, 5);
      const regionLen = bytes[9] as number;
      if (payload.length < 9 + regionLen + 1) throw protocolError("ServerInfo region truncated");
      const region = new TextDecoder().decode(bytes.subarray(10, 10 + regionLen));
      const connIdOffset = 10 + regionLen;
      const connIdLen = bytes[connIdOffset] as number;
      if (payload.length < 9 + regionLen + 1 + connIdLen) {
        throw protocolError("ServerInfo conn_id truncated");
      }
      const connId = new TextDecoder().decode(bytes.subarray(connIdOffset + 1, connIdOffset + 1 + connIdLen));
      return { type: "serverInfo", maxPayload, maxConnAgeS, region, connId };
    }
    case FrameType.Recv: {
      if (payload.length < 33) throw protocolError("Recv payload must be at least 33 bytes");
      return {
        type: "recv",
        src: bytes.slice(1, 33),
        ecn: bytes[33] as number,
        datagram: bytes.slice(34),
      };
    }
    case FrameType.RecvBatch: {
      if (payload.length < 35) throw protocolError("RecvBatch payload must be at least 35 bytes");
      return {
        type: "recvBatch",
        src: bytes.slice(1, 33),
        ecn: bytes[33] as number,
        segmentSize: view.getUint16(34),
        datagrams: bytes.slice(36),
      };
    }
    case FrameType.PeerGone: {
      if (payload.length !== 32) throw protocolError("PeerGone payload must be exactly 32 bytes");
      return { type: "peerGone", peer: bytes.slice(1, 33) };
    }
    case FrameType.Status: {
      if (payload.length !== 1) throw protocolError("Status payload must be exactly 1 byte");
      return { type: "status", code: bytes[1] as number };
    }
    case FrameType.Restarting: {
      if (payload.length !== 8) throw protocolError("Restarting payload must be exactly 8 bytes");
      return {
        type: "restarting",
        reconnectInMs: view.getUint32(1),
        tryForMs: view.getUint32(5),
      };
    }
    default:
      return { type: "unknown", frameType };
  }
}
