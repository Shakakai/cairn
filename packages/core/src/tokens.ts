/**
 * Access tokens (docs/01 §3.3, 10): proof of permission, separate from the auth blob's
 * proof of key ownership. Pure verification; issuance (minting) is for the dev CLI and
 * tests.
 *
 * ```
 * token  = base64url(payload_json) "." base64url(ed25519_signature(payload_json_bytes))
 * payload = { v:1, kid:"2026-10", sub:"<endpoint z32 | *>", aud:"cairn.example.net",
 *             iat:<unix s>, exp:<unix s> }
 * ```
 *
 * Verification: key by `kid` from the deployment's public-key map, strict Ed25519,
 * `aud` matches this deployment, `iat ≤ now + 60s`, `exp > now`, `sub` is the
 * connecting endpoint or `*`.
 */

import { decodeBase64Url, encodeBase64Url } from "./auth.js";
import { ed25519Sign, ed25519VerifyStrict } from "./crypto.js";
import { type EndpointId, endpointIdFromBytes } from "./keys.js";

export interface AccessTokenPayload {
  v: 1;
  /** Key id into the deployment's public-key map (doc 10 rotation). */
  kid: string;
  /** The endpoint this token grants, or "*" for any endpoint. */
  sub: string;
  /** Audience: this deployment's hostname. */
  aud: string;
  /** Issued-at, unix seconds. */
  iat: number;
  /** Expiry, unix seconds. */
  exp: number;
}

export const ACCESS_TOKEN_IAT_LEEWAY_S = 60;

export type TokenVerificationError =
  | "malformed"
  | "bad-signature"
  | "unknown-kid"
  | "wrong-audience"
  | "not-yet-valid"
  | "expired"
  | "wrong-subject";

export type TokenVerification = { ok: true } | { ok: false; reason: TokenVerificationError };

/** The deployment's token verification keys: kid -> base64 Ed25519 public key. */
export type TokenPublicKeys = Record<string, string>;

function parseToken(
  token: string,
): { payload: AccessTokenPayload; signature: Uint8Array; payloadBytes: Uint8Array } | TokenVerificationError {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return "malformed";
  const payloadBytes = safeB64(token.slice(0, dot));
  const signature = safeB64(token.slice(dot + 1));
  if (payloadBytes === undefined || signature === undefined) return "malformed";
  if (signature.length !== 64) return "malformed";
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return "malformed";
  }
  const p = json as Partial<AccessTokenPayload>;
  if (
    p?.v !== 1 ||
    typeof p.kid !== "string" ||
    typeof p.sub !== "string" ||
    typeof p.aud !== "string" ||
    typeof p.iat !== "number" ||
    typeof p.exp !== "number"
  ) {
    return "malformed";
  }
  return { payload: p as AccessTokenPayload, signature, payloadBytes };
}

function safeB64(text: string): Uint8Array | undefined {
  try {
    return decodeBase64Url(text);
  } catch {
    return undefined;
  }
}

/**
 * Verify an access token for `endpoint` at this deployment (`audience`), now in unix
 * seconds. `publicKeys` is the ACCESS_TOKEN_PUBLIC_KEYS map (doc 10).
 */
export function verifyAccessToken(
  token: string,
  endpoint: EndpointId,
  audience: string,
  nowSec: number,
  publicKeys: TokenPublicKeys,
): TokenVerification {
  const parsed = parseToken(token);
  if (typeof parsed === "string") return { ok: false, reason: parsed };
  const { payload, signature, payloadBytes } = parsed;

  const keyB64 = publicKeys[payload.kid];
  if (keyB64 === undefined) return { ok: false, reason: "unknown-kid" };
  const keyBytes = safeB64(keyB64);
  if (keyBytes === undefined || keyBytes.length !== 32) return { ok: false, reason: "unknown-kid" };

  if (!ed25519VerifyStrict(signature, payloadBytes, keyBytes)) {
    return { ok: false, reason: "bad-signature" };
  }
  if (payload.aud !== audience) return { ok: false, reason: "wrong-audience" };
  if (payload.iat > nowSec + ACCESS_TOKEN_IAT_LEEWAY_S) return { ok: false, reason: "not-yet-valid" };
  if (payload.exp <= nowSec) return { ok: false, reason: "expired" };
  if (payload.sub !== "*" && payload.sub !== endpoint) return { ok: false, reason: "wrong-subject" };
  return { ok: true };
}

/** Build the signed token string (dev CLI and tests; the network backend mints real ones). */
export function mintAccessToken(payload: AccessTokenPayload, secretKey: Uint8Array): string {
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const signature = ed25519Sign(payloadBytes, secretKey);
  return `${encodeBase64Url(payloadBytes)}.${encodeBase64Url(signature)}`;
}

/** Convenience: the endpoint id a token was minted for (no verification). */
export function tokenSubject(token: string): string | undefined {
  const parsed = parseToken(token);
  if (typeof parsed === "string") return undefined;
  return parsed.payload.sub === "*" ? undefined : parsed.payload.sub;
}

export { endpointIdFromBytes };
