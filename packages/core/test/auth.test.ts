import { describe, expect, it } from "vitest";
import {
  blake3DeriveKey,
  createAuthBlob,
  decodeBase64Url,
  ed25519PublicKey,
  ed25519Sign,
  ed25519VerifyStrict,
  encodeBase64Url,
  NonceCache,
  normalizeHost,
  verifyAuthBlob,
} from "../src/index.js";

const HOST = "cairn.example.net";
const SEED = new Uint8Array(32);
for (let i = 0; i < 32; i++) SEED[i] = i + 1;
const PUBLIC = ed25519PublicKey(SEED);

function freshBlob(timestampMs: number, nonce: Uint8Array) {
  return createAuthBlob({
    secretKey: SEED,
    host: HOST,
    endpointBytes: PUBLIC,
    timestampMs: BigInt(timestampMs),
    nonce,
  });
}

describe("auth blob", () => {
  it("create/verify round trip", () => {
    const nonce = new Uint8Array(16).fill(0xab);
    const ts = 1_800_000_000_000;
    const blob = freshBlob(ts, nonce);
    const verified = verifyAuthBlob(blob, HOST, ts, 60_000);
    expect(verified.ok).toBe(true);
  });

  it("wrong host fails as bad-signature", () => {
    const ts = 1_800_000_000_000;
    const blob = freshBlob(ts, new Uint8Array(16).fill(1));
    const result = verifyAuthBlob(blob, "other.example.net", ts, 60_000);
    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("non-canonical S rejected (strict verification)", () => {
    const ts = 1_800_000_000_000;
    const blob = freshBlob(ts, new Uint8Array(16).fill(2));
    // L = 2^252 + 27742317777372353535851937790883648493, little-endian.
    const L = BigInt("7237005577332262213973186563042994240857116359379907606001950938285454250989");
    const s = new Uint8Array(32);
    let tmp = L;
    for (let i = 0; i < 32; i++) {
      s[i] = Number(tmp & 0xffn);
      tmp >>= 8n;
    }
    blob.set(s, 89); // S occupies the last 32 bytes of the 64-byte signature
    const result = verifyAuthBlob(blob, HOST, ts, 60_000);
    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("small-order public keys rejected as bad-key", () => {
    const ts = 1_800_000_000_000;
    const blob = freshBlob(ts, new Uint8Array(16).fill(3));
    blob.set(new Uint8Array(32), 1); // identity point
    expect(verifyAuthBlob(blob, HOST, ts, 60_000)).toEqual({ ok: false, reason: "bad-key" });
    blob.set([1], 1); // order-2 point
    expect(verifyAuthBlob(blob, HOST, ts, 60_000)).toEqual({ ok: false, reason: "bad-key" });
  });

  it("normalizeHost strips port and lowercases", () => {
    expect(normalizeHost("Cairn.Example.NET:8443")).toBe("cairn.example.net");
    expect(normalizeHost("cairn.example.net")).toBe("cairn.example.net");
    expect(normalizeHost("[2001:db8::1]:443")).toBe("[2001:db8::1]");
  });
});

describe("base64url", () => {
  it("round trips without padding", () => {
    const data = new Uint8Array([0xfb, 0xff, 0xfe, 0x01, 0x30]);
    const text = encodeBase64Url(data);
    expect(text).not.toMatch(/[+=/]/);
    expect(decodeBase64Url(text)).toEqual(data);
    expect(encodeBase64Url(new Uint8Array(121))).toHaveLength(162); // auth blob size
  });

  it("rejects invalid input", () => {
    expect(() => decodeBase64Url("a")).toThrow(); // length % 4 == 1
    expect(() => decodeBase64Url("a*b")).toThrow();
    expect(() => decodeBase64Url("a=b")).toThrow();
  });
});

describe("NonceCache", () => {
  it("rejects replays within the TTL and expires after it", () => {
    const cache = new NonceCache(100);
    const nonce = new Uint8Array(16).fill(7);
    expect(cache.claim("ep-a", nonce, 10_000, 0)).toBe(true);
    expect(cache.claim("ep-a", nonce, 10_000, 5_000)).toBe(false); // replay
    expect(cache.claim("ep-a", nonce, 10_000, 10_001)).toBe(true); // expired, fresh claim
  });

  it("scopes nonces per endpoint", () => {
    const cache = new NonceCache(100);
    const nonce = new Uint8Array(16).fill(7);
    expect(cache.claim("ep-a", nonce, 10_000, 0)).toBe(true);
    expect(cache.claim("ep-b", nonce, 10_000, 0)).toBe(true);
  });

  it("evicts oldest beyond capacity", () => {
    const cache = new NonceCache(2);
    const n = (b: number) => new Uint8Array(16).fill(b);
    expect(cache.claim("ep", n(1), 60_000, 0)).toBe(true);
    expect(cache.claim("ep", n(2), 60_000, 0)).toBe(true);
    expect(cache.claim("ep", n(3), 60_000, 0)).toBe(true); // evicts n(1)
    expect(cache.size).toBe(2);
    expect(cache.claim("ep", n(1), 60_000, 1)).toBe(true); // n(1) was evicted; re-claim evicts n(2)
    expect(cache.claim("ep", n(2), 60_000, 1)).toBe(true); // n(2) was evicted by the n(1) re-claim
    expect(cache.claim("ep", n(1), 60_000, 1)).toBe(false); // n(1) is present
  });
});

describe("BLAKE3 derive-key", () => {
  it("matches the documented parity value", () => {
    // host ‖ 0x00 ‖ endpoint(32 zeros) ‖ timestamp(8 zeros) ‖ nonce(16 zeros) = 74 bytes.
    const material = new Uint8Array(74);
    const host = new TextEncoder().encode("cairn.example.net");
    material.set(host, 0);
    material[host.length] = 0x00;
    const key = blake3DeriveKey("switchback v1 connect auth", material);
    expect(Buffer.from(key).toString("hex")).toBe(
      "31f4b855e7853ca9cd7425ce3b3651246683de3a1927a097b9e3a2a15c80509a",
    );
  });
});

describe("strict ed25519", () => {
  it("verifies our own signatures and rejects tampering", () => {
    const msg = new TextEncoder().encode("hello switchback");
    const sig = ed25519Sign(msg, SEED);
    expect(ed25519VerifyStrict(sig, msg, PUBLIC)).toBe(true);
    const bad = new Uint8Array(sig);
    bad[10] ^= 0xff;
    expect(ed25519VerifyStrict(bad, msg, PUBLIC)).toBe(false);
    expect(ed25519VerifyStrict(sig, msg, new Uint8Array(32))).toBe(false); // small-order key
  });
});
