/**
 * Thin wrappers over @noble/* crypto (docs/02). Strict Ed25519 = canonical S and R, no
 * small-order keys: `zip215: false` plus an explicit small-order check, matching
 * `verify_strict` in the Rust client (doc 01 §3.2 check 4).
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { blake3 } from "@noble/hashes/blake3.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { isSmallOrder } from "./keys.js";

export const CONNECT_AUTH_CONTEXT = "switchback v1 connect auth";
export const DERIVED_KEY_LENGTH = 32;
export const SIGNATURE_LENGTH = 64;

/** BLAKE3 in derive-key mode (parity with Rust `blake3::derive_key`). */
export function blake3DeriveKey(context: string, keyMaterial: Uint8Array): Uint8Array {
  return blake3(keyMaterial, { context: utf8ToBytes(context), dkLen: DERIVED_KEY_LENGTH });
}

/**
 * Strict Ed25519 verification. `pubKey` must be a valid non-small-order point and `sig` must
 * have canonical R and S. Returns false on any malformation (never throws).
 */
export function ed25519VerifyStrict(sig: Uint8Array, msg: Uint8Array, pubKey: Uint8Array): boolean {
  if (sig.length !== SIGNATURE_LENGTH || pubKey.length !== 32) return false;
  if (isSmallOrder(pubKey)) return false;
  try {
    return ed25519.verify(sig, msg, pubKey, { zip215: false });
  } catch {
    return false;
  }
}

/** Deterministic Ed25519 signature (RFC 8032); used by tooling and tests, never by the relay core. */
export function ed25519Sign(msg: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return ed25519.sign(msg, secretKey);
}

export function ed25519PublicKey(secretKey: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(secretKey);
}
