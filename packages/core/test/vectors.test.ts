import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createAuthBlob,
  decodeBase64Url,
  decodeClientFrame,
  decodeRelayFrame,
  deriveAuthMessageKey,
  encode,
  endpointIdFromBytes,
  FrameError,
  forwardTransform,
  verifyAuthBlob,
} from "../src/index.js";

const VECTORS_DIR = fileURLToPath(new URL("./vectors", import.meta.url));

function loadVectors(name: string): any {
  return JSON.parse(readFileSync(`${VECTORS_DIR}/${name}`, "utf8"));
}

function unhex(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

describe("shared vectors: auth", () => {
  const auth = loadVectors("auth.json");

  it("BLAKE3 derive-key parity (CLAUDE.md / doc 01 §3.2 vector)", () => {
    const material = unhex(auth.blake3_parity.key_material_hex);
    const key = deriveAuthMessageKey(material);
    expect(Buffer.from(key).toString("hex")).toBe(auth.blake3_parity.expected_key_hex);
    expect(auth.blake3_parity.expected_key_hex).toBe(
      "31f4b855e7853ca9cd7425ce3b3651246683de3a1927a097b9e3a2a15c80509a",
    );
  });

  it("create case: re-created blob matches, and verifies ok", () => {
    const c = auth.create;
    const endpointBytes = unhex(c.endpoint_hex);
    const nonce = unhex(c.nonce_hex);
    const blob = createAuthBlob({
      secretKey: unhex(c.secret_seed_hex),
      host: c.host,
      endpointBytes,
      timestampMs: BigInt(c.timestamp_ms),
      nonce,
    });
    expect(Buffer.from(blob).toString("hex")).toBe(c.blob_hex);
    expect(Buffer.from(decodeBase64Url(c.blob_b64)).toString("hex")).toBe(c.blob_hex);
    expect(endpointIdFromBytes(endpointBytes)).toBe(c.endpoint_id);

    const verified = verifyAuthBlob(blob, c.host, c.timestamp_ms, 60_000);
    expect(verified.ok).toBe(true);
  });

  it.each(auth.verify.map((c: any) => [c.name, c] as const))("verify: %s", (_name, c) => {
    const blob = unhex(c.blob_hex);
    const result = verifyAuthBlob(blob, c.host, c.now_ms, c.skew_ms);
    if (c.expected === "ok") {
      expect(result.ok).toBe(true);
    } else {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe(c.expected);
    }
  });
});

describe("shared vectors: frames", () => {
  const frames = loadVectors("frames.json");

  it.each(frames.valid.map((c: any) => [c.name, c] as const))("valid: %s", (_name, c) => {
    const bytes = unhex(c.frame_hex);
    const d = c.decoded;
    if (d.type === "send") {
      expect(decodeClientFrame(bytes)).toEqual({
        type: "send",
        dst: unhex(d.dst),
        ecn: d.ecn,
        datagram: unhex(d.datagram_hex),
      });
      const re = new Uint8Array(1 + 32 + 1 + unhex(d.datagram_hex).length);
      re[0] = 0x02;
      re.set(unhex(d.dst), 1);
      re[33] = d.ecn;
      re.set(unhex(d.datagram_hex), 34);
      expect(Buffer.from(re).toString("hex")).toBe(c.frame_hex);
    } else if (d.type === "sendBatch") {
      expect(decodeClientFrame(bytes)).toEqual({
        type: "sendBatch",
        dst: unhex(d.dst),
        ecn: d.ecn,
        segmentSize: d.segment_size,
        datagrams: unhex(d.datagrams_hex),
      });
    } else if (d.type === "recv") {
      expect(decodeRelayFrame(bytes)).toEqual({
        type: "recv",
        src: unhex(d.src),
        ecn: d.ecn,
        datagram: unhex(d.datagram_hex),
      });
      expect(
        Buffer.from(encode.recv({ src: unhex(d.src), ecn: d.ecn, datagram: unhex(d.datagram_hex) })).toString(
          "hex",
        ),
      ).toBe(c.frame_hex);
    } else if (d.type === "recvBatch") {
      expect(decodeRelayFrame(bytes)).toEqual({
        type: "recvBatch",
        src: unhex(d.src),
        ecn: d.ecn,
        segmentSize: d.segment_size,
        datagrams: unhex(d.datagrams_hex),
      });
      expect(
        Buffer.from(
          encode.recvBatch({
            src: unhex(d.src),
            ecn: d.ecn,
            segmentSize: d.segment_size,
            datagrams: unhex(d.datagrams_hex),
          }),
        ).toString("hex"),
      ).toBe(c.frame_hex);
    } else if (d.type === "peerGone") {
      expect(decodeRelayFrame(bytes)).toEqual({ type: "peerGone", peer: unhex(d.peer) });
      expect(Buffer.from(encode.peerGone(unhex(d.peer))).toString("hex")).toBe(c.frame_hex);
    } else if (d.type === "status") {
      expect(decodeRelayFrame(bytes)).toEqual({ type: "status", code: d.code });
      expect(Buffer.from(encode.status(d.code)).toString("hex")).toBe(c.frame_hex);
    } else if (d.type === "restarting") {
      expect(decodeRelayFrame(bytes)).toEqual({
        type: "restarting",
        reconnectInMs: d.reconnect_in_ms,
        tryForMs: d.try_for_ms,
      });
      expect(Buffer.from(encode.restarting(d.reconnect_in_ms, d.try_for_ms)).toString("hex")).toBe(
        c.frame_hex,
      );
    } else if (d.type === "serverInfo") {
      expect(decodeRelayFrame(bytes)).toEqual({
        type: "serverInfo",
        maxPayload: d.max_payload,
        maxConnAgeS: d.max_conn_age_s,
        region: d.region,
        connId: d.conn_id,
      });
      expect(
        Buffer.from(
          encode.serverInfo({
            maxPayload: d.max_payload,
            maxConnAgeS: d.max_conn_age_s,
            region: d.region,
            connId: d.conn_id,
          }),
        ).toString("hex"),
      ).toBe(c.frame_hex);
    } else {
      throw new Error(`unknown vector type ${d.type}`);
    }
  });

  it.each(frames.invalid.map((c: any) => [c.name, c] as const))("invalid: %s", (_name, c) => {
    let error: FrameError | undefined;
    try {
      decodeClientFrame(unhex(c.frame_hex));
    } catch (e) {
      error = e as FrameError;
    }
    expect(error).toBeInstanceOf(FrameError);
    expect(error?.code).toBe(c.expected_error.code);
  });
});

describe("shared vectors: forward transform", () => {
  const transform = loadVectors("transform.json");

  it.each(transform.cases.map((c: any) => [c.name, c] as const))("%s", (_name, c) => {
    const out = forwardTransform(unhex(c.client_frame_hex), unhex(c.src_key_hex));
    expect(Buffer.from(out).toString("hex")).toBe(c.expected_hex);
  });
});

describe("shared vectors: server info", () => {
  const serverInfo = loadVectors("server_info.json");

  it.each(serverInfo.cases.map((c: any) => [c.name, c] as const))("%s", (_name, c) => {
    expect(decodeRelayFrame(unhex(c.frame_hex))).toEqual({
      type: "serverInfo",
      maxPayload: c.decoded.max_payload,
      maxConnAgeS: c.decoded.max_conn_age_s,
      region: c.decoded.region,
      connId: c.decoded.conn_id,
    });
  });
});
