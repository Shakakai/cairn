/**
 * EndpointId bytes <-> z-base-32 text form, Ed25519 point validation and small-order checks
 * (docs/01 §3.2, docs/02).
 *
 * z-base-32 (Zooko's human-oriented base-32): alphabet below, bits consumed least-significant-bit
 * first within each byte, unpadded. 32 bytes encode to 52 characters; the last character carries
 * a single bit.
 */

import { ed25519 } from "@noble/curves/ed25519.js";

export type EndpointId = string;

export const ZBASE32_ALPHABET = "ybndrfg8ejkmcpqxot1uwisza345h769";
export const ENDPOINT_ID_LENGTH = 52; // z-base-32 of a 32-byte key
export const ENDPOINT_KEY_LENGTH = 32;

const DECODE_TABLE = new Int16Array(128).fill(-1);
for (let i = 0; i < ZBASE32_ALPHABET.length; i++) {
  DECODE_TABLE[ZBASE32_ALPHABET.charCodeAt(i)] = i;
}

/** Encode 32 key bytes to their canonical z-base-32 EndpointId. */
export function endpointIdFromBytes(bytes: Uint8Array): EndpointId {
  if (bytes.length !== ENDPOINT_KEY_LENGTH) {
    throw new Error(`endpoint key must be ${ENDPOINT_KEY_LENGTH} bytes, got ${bytes.length}`);
  }
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer |= byte << bits;
    bits += 8;
    while (bits >= 5) {
      out += ZBASE32_ALPHABET[buffer & 0x1f];
      buffer >>= 5;
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += ZBASE32_ALPHABET[buffer & 0x1f];
  }
  return out;
}

/** Decode a z-base-32 EndpointId to key bytes. Throws on malformed input. */
export function endpointIdToBytes(id: EndpointId): Uint8Array {
  const out = new Uint8Array(ENDPOINT_KEY_LENGTH);
  let buffer = 0;
  let bits = 0;
  let written = 0;
  for (let i = 0; i < id.length; i++) {
    const code = id.charCodeAt(i);
    if (code > 127) throw new Error("endpoint id: character out of range");
    const value = DECODE_TABLE[code] ?? -1;
    if (value < 0) throw new Error("endpoint id: character not in z-base-32 alphabet");
    buffer |= value << bits;
    bits += 5;
    if (bits >= 8) {
      if (written >= ENDPOINT_KEY_LENGTH) throw new Error("endpoint id: too long");
      out[written] = buffer & 0xff;
      written += 1;
      buffer >>= 8;
      bits -= 8;
    }
  }
  // The final symbol must carry exactly the remaining bits and nothing more.
  const leftoverBits = bits;
  if (leftoverBits > 0 && buffer !== 0) {
    throw new Error("endpoint id: non-canonical trailing bits");
  }
  if (written !== ENDPOINT_KEY_LENGTH) throw new Error("endpoint id: wrong length");
  if (id.length !== ENDPOINT_ID_LENGTH) throw new Error("endpoint id: must be 52 characters");
  return out;
}

export function isValidEndpointId(id: string): boolean {
  try {
    endpointIdToBytes(id);
    return true;
  } catch {
    return false;
  }
}

/** True iff `bytes` is a valid canonical Ed25519 point encoding (zip215: false). */
export function isValidPoint(bytes: Uint8Array): boolean {
  if (bytes.length !== ENDPOINT_KEY_LENGTH) return false;
  try {
    ed25519.Point.fromBytes(bytes, false);
    return true;
  } catch {
    return false;
  }
}

/** True iff `bytes` is a valid Ed25519 point of small (torsion) order. */
export function isSmallOrder(bytes: Uint8Array): boolean {
  if (bytes.length !== ENDPOINT_KEY_LENGTH) return false;
  try {
    return ed25519.Point.fromBytes(bytes, false).isSmallOrder();
  } catch {
    return false;
  }
}

/**
 * True iff `bytes` is a usable endpoint key: a valid, canonical, non-small-order Ed25519 point
 * (doc 01 §3.2 check 3 and §4.2 dst rule).
 */
export function isValidEndpointKey(bytes: Uint8Array): boolean {
  return isValidPoint(bytes) && !isSmallOrder(bytes);
}
