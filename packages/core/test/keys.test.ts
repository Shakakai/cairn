import { describe, expect, it } from "vitest";
import {
  ed25519PublicKey,
  endpointIdFromBytes,
  endpointIdToBytes,
  isSmallOrder,
  isValidEndpointId,
  isValidEndpointKey,
  isValidPoint,
} from "../src/index.js";

describe("z-base-32 EndpointIds", () => {
  it("fixed vectors", () => {
    expect(endpointIdFromBytes(new Uint8Array(32))).toBe("y".repeat(52));
    expect(endpointIdFromBytes(new Uint8Array(32).fill(0xff))).toBe(`${"9".repeat(51)}b`);
  });

  it("round trips", () => {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = (i * 37 + 11) & 0xff;
    const id = endpointIdFromBytes(bytes);
    expect(id).toHaveLength(52);
    expect(endpointIdToBytes(id)).toEqual(bytes);
    expect(isValidEndpointId(id)).toBe(true);
  });

  it("rejects malformed ids", () => {
    const id = endpointIdFromBytes(new Uint8Array(32));
    expect(isValidEndpointId(id.toUpperCase())).toBe(false); // alphabet is lowercase
    expect(isValidEndpointId(id.slice(0, 51))).toBe(false); // too short
    expect(isValidEndpointId(`${id.slice(0, 51)}0`)).toBe(false); // '0' not in alphabet
    expect(isValidEndpointId(`${id}y`)).toBe(false); // too long
  });

  it("point validation and small-order", () => {
    const identity = new Uint8Array(32);
    expect(isValidPoint(identity)).toBe(true);
    expect(isSmallOrder(identity)).toBe(true);
    expect(isValidEndpointKey(identity)).toBe(false);

    const order2 = new Uint8Array(32);
    order2[0] = 1;
    expect(isSmallOrder(order2)).toBe(true);
    expect(isValidEndpointKey(order2)).toBe(false);

    // A real key is valid and not small-order.
    const key = endpointIdToBytes(endpointIdFromBytes(ed25519PublicKey(new Uint8Array(32).fill(0xab))));
    expect(isValidEndpointKey(key)).toBe(true);
  });
});
