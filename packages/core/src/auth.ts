/**
 * Connect-auth blob (doc 01 §3.2): encode, decode, verify, plus the NonceCache used for replay
 * protection in memory deployments (docs/02). Pure: callers supply time; signing is
 * deterministic and used by tooling/tests only.
 */

import { blake3DeriveKey, CONNECT_AUTH_CONTEXT, ed25519Sign, ed25519VerifyStrict } from "./crypto.js";
import { type EndpointId, endpointIdFromBytes, isSmallOrder, isValidPoint } from "./keys.js";

export const AUTH_BLOB_VERSION = 0x01;
export const AUTH_BLOB_LENGTH = 121; // 1 + 32 + 8 + 16 + 64
export const AUTH_TIMESTAMP_LENGTH = 8;
export const AUTH_NONCE_LENGTH = 16;
export const AUTH_SIGNATURE_LENGTH = 64;

export type AuthFailure = "missing" | "malformed" | "stale" | "bad-key" | "bad-signature";

export interface AuthBlob {
  version: number;
  endpointBytes: Uint8Array;
  timestampMs: bigint;
  nonce: Uint8Array;
  signature: Uint8Array;
}

export type DecodeAuthResult = { ok: true; blob: AuthBlob } | { ok: false; reason: "malformed" };

// ---------------------------------------------------------------------------
// base64url (no padding) — pure implementation, no Buffer in the core.
// ---------------------------------------------------------------------------

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_DECODE_TABLE = new Int16Array(128).fill(-1);
for (let i = 0; i < B64_ALPHABET.length; i++) {
  B64_DECODE_TABLE[B64_ALPHABET.charCodeAt(i)] = i;
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = i + 1 < bytes.length ? (bytes[i + 1] as number) : 0;
    const b2 = i + 2 < bytes.length ? (bytes[i + 2] as number) : 0;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    if (i + 1 < bytes.length) out += B64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)];
    if (i + 2 < bytes.length) out += B64_ALPHABET[b2 & 0x3f];
  }
  return out;
}

/** Decode base64url without padding. Throws on invalid characters or length % 4 == 1. */
export function decodeBase64Url(text: string): Uint8Array {
  if (text.length % 4 === 1) throw new Error("base64url: invalid length");
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 127) throw new Error("base64url: character out of range");
    const value = B64_DECODE_TABLE[code] ?? -1;
    if (value < 0) throw new Error("base64url: invalid character");
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      out.push(buffer >> (bits - 8));
      bits -= 8;
      buffer &= (1 << bits) - 1;
    }
  }
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------
// Auth blob
// ---------------------------------------------------------------------------

/** Lower-case the host and strip any port (doc 01 §3.2). */
export function normalizeHost(host: string): string {
  const lower = host.toLowerCase();
  // IPv6 literals keep their brackets; only a trailing :port is removed.
  if (lower.startsWith("[")) {
    const end = lower.indexOf("]");
    return end >= 0 ? lower.slice(0, end + 1) : lower;
  }
  const colon = lower.lastIndexOf(":");
  return colon >= 0 ? lower.slice(0, colon) : lower;
}

/** The message that is signed: BLAKE3-derive over host ‖ 0x00 ‖ endpoint ‖ timestamp ‖ nonce. */
export function buildAuthMessage(
  host: string,
  endpointBytes: Uint8Array,
  timestampMs: bigint,
  nonce: Uint8Array,
): Uint8Array {
  const normalized = normalizeHost(host);
  const encoder = new TextEncoder();
  const hostBytes = encoder.encode(normalized);
  const msg = new Uint8Array(hostBytes.length + 1 + 32 + AUTH_TIMESTAMP_LENGTH + nonce.length);
  msg.set(hostBytes, 0);
  msg[hostBytes.length] = 0x00;
  msg.set(endpointBytes, hostBytes.length + 1);
  new DataView(msg.buffer).setBigUint64(hostBytes.length + 1 + 32, BigInt(timestampMs));
  msg.set(nonce, hostBytes.length + 1 + 32 + AUTH_TIMESTAMP_LENGTH);
  return msg;
}

/** The 32-byte derived key the signature commits to. */
export function deriveAuthMessageKey(msg: Uint8Array): Uint8Array {
  return blake3DeriveKey(CONNECT_AUTH_CONTEXT, msg);
}

export interface AuthBlobParts {
  endpointBytes: Uint8Array;
  timestampMs: bigint;
  nonce: Uint8Array;
  signature: Uint8Array;
}

/** Serialize an auth blob (121 bytes). `version` field is fixed at 0x01. */
export function encodeAuthBlob(parts: AuthBlobParts): Uint8Array {
  const out = new Uint8Array(AUTH_BLOB_LENGTH);
  out[0] = AUTH_BLOB_VERSION;
  out.set(parts.endpointBytes, 1);
  new DataView(out.buffer).setBigUint64(33, BigInt(parts.timestampMs));
  out.set(parts.nonce, 41);
  out.set(parts.signature, 57);
  return out;
}

/** Parse an auth blob. Checks only structural validity (doc 01 §3.2 check 1). */
export function decodeAuthBlob(bytes: Uint8Array): DecodeAuthResult {
  if (bytes.length !== AUTH_BLOB_LENGTH) return { ok: false, reason: "malformed" };
  if (bytes[0] !== AUTH_BLOB_VERSION) return { ok: false, reason: "malformed" };
  return {
    ok: true,
    blob: {
      version: bytes[0],
      endpointBytes: bytes.slice(1, 33),
      timestampMs: new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(33),
      nonce: bytes.slice(41, 57),
      signature: bytes.slice(57, 121),
    },
  };
}

/**
 * Create and sign a fresh auth blob (new timestamp and nonce for every connection attempt).
 * Deterministic given the inputs; callers generate the nonce and read the clock.
 */
export function createAuthBlob(args: {
  secretKey: Uint8Array;
  host: string;
  endpointBytes: Uint8Array;
  timestampMs: bigint;
  nonce: Uint8Array;
}): Uint8Array {
  const msg = buildAuthMessage(args.host, args.endpointBytes, args.timestampMs, args.nonce);
  const signature = ed25519Sign(deriveAuthMessageKey(msg), args.secretKey);
  return encodeAuthBlob({
    endpointBytes: args.endpointBytes,
    timestampMs: args.timestampMs,
    nonce: args.nonce,
    signature,
  });
}

export type VerifyAuthResult =
  | { ok: true; endpoint: EndpointId; endpointBytes: Uint8Array; nonce: Uint8Array }
  | { ok: false; reason: Exclude<AuthFailure, "missing"> };

/**
 * Full verification per doc 01 §3.2 checks 1–4. `nowMs` and `skewMs` come from the caller
 * (Env); the replay check (check 5) happens in the Router via `claimNonce` (doc 03).
 */
export function verifyAuthBlob(
  blobBytes: Uint8Array,
  host: string,
  nowMs: number,
  skewMs: number,
): VerifyAuthResult {
  const decoded = decodeAuthBlob(blobBytes);
  if (!decoded.ok) return { ok: false, reason: "malformed" };
  const { blob } = decoded;

  // Check 2: freshness.
  const skew = BigInt(skewMs);
  const age = blob.timestampMs - BigInt(nowMs);
  if (age > skew || age < -skew) return { ok: false, reason: "stale" };

  // Check 3: key must be a valid point, not small-order.
  if (!isValidPoint(blob.endpointBytes) || isSmallOrder(blob.endpointBytes)) {
    return { ok: false, reason: "bad-key" };
  }

  // Check 4: strict signature.
  const msg = buildAuthMessage(host, blob.endpointBytes, blob.timestampMs, blob.nonce);
  if (!ed25519VerifyStrict(blob.signature, deriveAuthMessageKey(msg), blob.endpointBytes)) {
    return { ok: false, reason: "bad-signature" };
  }

  return {
    ok: true,
    endpoint: endpointIdFromBytes(blob.endpointBytes),
    endpointBytes: blob.endpointBytes,
    nonce: blob.nonce,
  };
}

// ---------------------------------------------------------------------------
// NonceCache — bounded, expiring (endpoint, nonce) set for replay protection (docs/02, 03).
// ---------------------------------------------------------------------------

interface NonceEntry {
  expiresAtMs: number;
}

/** LRU map keyed by `endpoint|nonceHex`; entries expire after ttlMs. Not thread-safe (per isolate). */
export class NonceCache {
  private readonly entries = new Map<string, NonceEntry>();

  constructor(
    private readonly capacity: number,
    private readonly ttlMs: number,
  ) {}

  /**
   * Record `(endpoint, nonce)` for `ttlMs`. Returns false iff it was already recorded and
   * hasn't expired (replay), or the cache is full of fresher entries.
   */
  claim(endpoint: EndpointId, nonce: Uint8Array, nowMs: number): boolean {
    this.purgeExpired(nowMs);
    const key = `${endpoint}|${encodeBase64Url(nonce)}`;
    const existing = this.entries.get(key);
    if (existing && existing.expiresAtMs > nowMs) return false;
    if (existing) this.entries.delete(key); // re-claim after expiry: refresh recency
    while (this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { expiresAtMs: nowMs + this.ttlMs });
    return true;
  }

  /** Drop expired entries. Called by claim and periodically by adapters. */
  purgeExpired(nowMs: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAtMs <= nowMs) this.entries.delete(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
