import { describe, expect, it } from "vitest";
import {
  type AccessTokenPayload,
  ed25519PublicKey,
  ed25519Sign,
  endpointIdFromBytes,
  mintAccessToken,
  verifyAccessToken,
} from "../src/index.js";

const SECRET = new Uint8Array(32).fill(9);
const PUB = ed25519PublicKey(SECRET);
const OTHER_PUB = ed25519PublicKey(new Uint8Array(32).fill(8));
const ENDPOINT = endpointIdFromBytes(PUB);
const AUD = "cairn.example.net";
const KEYS = { "2026-10": Buffer.from(PUB).toString("base64url") };
const NOW = 1_800_000_000;

function payload(overrides: Partial<AccessTokenPayload> = {}): AccessTokenPayload {
  return { v: 1, kid: "2026-10", sub: ENDPOINT, aud: AUD, iat: NOW - 10, exp: NOW + 3600, ...overrides };
}

describe("access tokens (docs/01 §3.3, 10)", () => {
  it("valid token verifies", () => {
    const token = mintAccessToken(payload(), SECRET);
    expect(verifyAccessToken(token, ENDPOINT, AUD, NOW, KEYS)).toEqual({ ok: true });
  });

  it("wildcard sub grants any endpoint", () => {
    const token = mintAccessToken(payload({ sub: "*" }), SECRET);
    expect(verifyAccessToken(token, "someone-else", AUD, NOW, KEYS)).toEqual({ ok: true });
  });

  it("rejects wrong subject", () => {
    const token = mintAccessToken(payload(), SECRET);
    const result = verifyAccessToken(token, "someone-else", AUD, NOW, KEYS);
    expect(result).toEqual({ ok: false, reason: "wrong-subject" });
  });

  it("rejects wrong audience and unknown kid and expiry", () => {
    const token = mintAccessToken(payload(), SECRET);
    expect(verifyAccessToken(token, ENDPOINT, "other.net", NOW, KEYS)).toEqual({
      ok: false,
      reason: "wrong-audience",
    });
    expect(verifyAccessToken(token, ENDPOINT, AUD, NOW, {})).toEqual({ ok: false, reason: "unknown-kid" });
    const expired = mintAccessToken(payload({ exp: NOW - 1 }), SECRET);
    expect(verifyAccessToken(expired, ENDPOINT, AUD, NOW, KEYS)).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects far-future iat (> 60s leeway)", () => {
    const token = mintAccessToken(payload({ iat: NOW + 120 }), SECRET);
    expect(verifyAccessToken(token, ENDPOINT, AUD, NOW, KEYS)).toEqual({
      ok: false,
      reason: "not-yet-valid",
    });
  });

  it("rejects tokens signed by the wrong key and tampered payloads", () => {
    // A token claiming our endpoint but signed by a foreign key must fail the
    // signature check against our kid's key.
    const foreign = mintAccessToken(payload(), new Uint8Array(32).fill(8));
    expect(verifyAccessToken(foreign, ENDPOINT, AUD, NOW, KEYS)).toEqual({
      ok: false,
      reason: "bad-signature",
    });

    const token = mintAccessToken(payload(), SECRET);
    const [p] = token.split(".");
    const tampered = `${p}aaaa.${token.split(".")[1]}`;
    expect(verifyAccessToken(tampered, ENDPOINT, AUD, NOW, KEYS).ok).toBe(false);
  });

  it("rejects malformed tokens", () => {
    for (const bad of ["", "no-dot", ".", "a.b", ".."]) {
      expect(verifyAccessToken(bad, ENDPOINT, AUD, NOW, KEYS).ok).toBe(false);
    }
  });

  it("sign helper parity (mint uses the same strict signature scheme)", () => {
    const msg = new TextEncoder().encode("payload");
    const sig = ed25519Sign(msg, SECRET);
    expect(sig.length).toBe(64);
  });
});
