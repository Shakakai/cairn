import { describe, expect, it } from "vitest";
import {
  createAuthBlob,
  defaultRelayConfig,
  type Env,
  ed25519PublicKey,
  encodeBase64Url,
  negotiateUpgrade,
  type UpgradeRequest,
} from "../src/index.js";

const HOST = "cairn.example.net";
const NOW = 1_800_000_000_000;
const SEED = new Uint8Array(32);
for (let i = 0; i < 32; i++) SEED[i] = i + 1;
const PUBLIC = ed25519PublicKey(SEED);

const env: Env = {
  nowMs: NOW,
  random: () => {
    throw new Error("core must not draw randomness here");
  },
  config: defaultRelayConfig,
  caps: { canPauseReads: true, serverPings: true, region: "test" },
};

function authHeader(timestampMs: number = NOW): string {
  const blob = createAuthBlob({
    secretKey: SEED,
    host: HOST,
    endpointBytes: PUBLIC,
    timestampMs: BigInt(timestampMs),
    nonce: new Uint8Array(16).fill(0x5a),
  });
  return encodeBase64Url(blob);
}

function baseRequest(overrides: Partial<UpgradeRequest> = {}): UpgradeRequest {
  return {
    method: "GET",
    path: "/v1/connect",
    headers: {
      host: HOST,
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-version": "13",
      "sec-websocket-protocol": "switchback.v1",
      "switchback-auth": authHeader(),
    },
    query: {},
    ...overrides,
  };
}

describe("negotiateUpgrade (doc 01 §3.1)", () => {
  it("accepts a valid upgrade", () => {
    const decision = negotiateUpgrade(baseRequest(), env);
    expect(decision).toMatchObject({
      ok: true,
      subprotocol: "switchback.v1",
    });
    if (decision.ok) {
      expect(decision.endpointBytes).toEqual(PUBLIC);
      expect(decision.nonce).toEqual(new Uint8Array(16).fill(0x5a));
    }
  });

  it("extracts bearer tokens (header and query)", () => {
    const withHeader = negotiateUpgrade(
      baseRequest({
        headers: { ...baseRequest().headers, authorization: "Bearer tok-123" },
      }),
      env,
    );
    expect(withHeader).toMatchObject({ ok: true, token: "tok-123" });

    const withQuery = negotiateUpgrade(baseRequest({ query: { token: "tok-456" } }), env);
    expect(withQuery).toMatchObject({ ok: true, token: "tok-456" });
  });

  it("accepts auth via ?auth= query (browser path)", () => {
    const req = baseRequest();
    const auth = req.headers["switchback-auth"] as string;
    const { ["switchback-auth"]: _omit, ...headers } = req.headers;
    const decision = negotiateUpgrade({ ...req, headers, query: { auth } }, env);
    expect(decision.ok).toBe(true);
  });

  it("404s non-connect paths", () => {
    const decision = negotiateUpgrade(baseRequest({ path: "/v1/other" }), env);
    expect(decision).toMatchObject({ ok: false, status: 404 });
  });

  it("400s non-GET, missing upgrade headers, missing key", () => {
    expect(negotiateUpgrade(baseRequest({ method: "POST" }), env)).toMatchObject({
      ok: false,
      status: 400,
    });
    const noUpgrade = baseRequest().headers;
    const { upgrade: _u, ...rest } = noUpgrade;
    expect(negotiateUpgrade(baseRequest({ headers: rest as UpgradeRequest["headers"] }), env)).toMatchObject({
      ok: false,
      status: 400,
    });
    const noKey = baseRequest().headers;
    const { "sec-websocket-key": _k, ...rest2 } = noKey;
    expect(negotiateUpgrade(baseRequest({ headers: rest2 as UpgradeRequest["headers"] }), env)).toMatchObject(
      {
        ok: false,
        status: 400,
      },
    );
  });

  it("426s non-13 websocket versions with the version header", () => {
    const decision = negotiateUpgrade(
      baseRequest({
        headers: { ...baseRequest().headers, "sec-websocket-version": "12" },
      }),
      env,
    );
    expect(decision).toMatchObject({
      ok: false,
      status: 426,
      headers: { "Sec-WebSocket-Version": "13" },
    });
  });

  it("400s missing/wrong subprotocol with the exact doc 01 body", () => {
    const noSub = baseRequest().headers;
    const { "sec-websocket-protocol": _s, ...rest } = noSub;
    const missing = negotiateUpgrade(baseRequest({ headers: rest as UpgradeRequest["headers"] }), env);
    expect(missing).toMatchObject({
      ok: false,
      status: 400,
      body: "unsupported protocol version; supported: switchback.v1",
    });

    const wrong = negotiateUpgrade(
      baseRequest({
        headers: { ...baseRequest().headers, "sec-websocket-protocol": "other.proto, another.v2" },
      }),
      env,
    );
    expect(wrong).toMatchObject({
      ok: false,
      status: 400,
      body: "unsupported protocol version; supported: switchback.v1",
    });

    // switchback.v1 among several offered protocols is accepted.
    const multi = negotiateUpgrade(
      baseRequest({
        headers: { ...baseRequest().headers, "sec-websocket-protocol": "other.proto, switchback.v1" },
      }),
      env,
    );
    expect(multi.ok).toBe(true);
  });

  it("401s missing auth", () => {
    const headers = baseRequest().headers;
    const { "switchback-auth": _a, ...rest } = headers;
    const decision = negotiateUpgrade(baseRequest({ headers: rest as UpgradeRequest["headers"] }), env);
    expect(decision).toMatchObject({ ok: false, status: 401, body: "auth: missing" });
  });

  it("401s malformed auth (bad base64, wrong length, wrong version)", () => {
    const badB64 = negotiateUpgrade(
      baseRequest({ headers: { ...baseRequest().headers, "switchback-auth": "%%%" } }),
      env,
    );
    expect(badB64).toMatchObject({ ok: false, status: 401, body: "auth: malformed" });

    const short = new Uint8Array(120);
    const tooShort = negotiateUpgrade(
      baseRequest({
        headers: { ...baseRequest().headers, "switchback-auth": encodeBase64Url(short) },
      }),
      env,
    );
    expect(tooShort).toMatchObject({ ok: false, status: 401, body: "auth: malformed" });

    const wrongVersion = encodeBase64Url(new Uint8Array(121).fill(0xaa));
    const decision = negotiateUpgrade(
      baseRequest({ headers: { ...baseRequest().headers, "switchback-auth": wrongVersion } }),
      env,
    );
    expect(decision).toMatchObject({ ok: false, status: 401, body: "auth: malformed" });
  });

  it("401s stale auth", () => {
    const decision = negotiateUpgrade(
      baseRequest({ headers: { ...baseRequest().headers, "switchback-auth": authHeader(NOW + 120_000) } }),
      env,
    );
    expect(decision).toMatchObject({ ok: false, status: 401, body: "auth: stale" });
  });

  it("401s bad-key for small-order endpoints", () => {
    const blob = createAuthBlob({
      secretKey: SEED,
      host: HOST,
      endpointBytes: PUBLIC,
      timestampMs: BigInt(NOW),
      nonce: new Uint8Array(16).fill(1),
    });
    blob.set(new Uint8Array(32), 1); // identity point
    const decision = negotiateUpgrade(
      baseRequest({ headers: { ...baseRequest().headers, "switchback-auth": encodeBase64Url(blob) } }),
      env,
    );
    expect(decision).toMatchObject({ ok: false, status: 401, body: "auth: bad-key" });
  });

  it("401s bad-signature", () => {
    const otherSeed = new Uint8Array(32).fill(0x77);
    const blob = createAuthBlob({
      secretKey: otherSeed,
      host: "other.example.net", // signed for a different host
      endpointBytes: ed25519PublicKey(otherSeed),
      timestampMs: BigInt(NOW),
      nonce: new Uint8Array(16).fill(2),
    });
    const decision = negotiateUpgrade(
      baseRequest({ headers: { ...baseRequest().headers, "switchback-auth": encodeBase64Url(blob) } }),
      env,
    );
    expect(decision).toMatchObject({ ok: false, status: 401, body: "auth: bad-signature" });
  });
});
