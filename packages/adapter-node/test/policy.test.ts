import { TestClient } from "@cairn/conformance";
import { ed25519PublicKey, type RelayConfig } from "@cairn/core";
import { afterEach, describe, expect, it } from "vitest";
import { type RelayHandle, startRelay } from "../src/relay.js";

const SECRET = new Uint8Array(32).fill(9);
const KEYS = JSON.stringify({ dev: Buffer.from(ed25519PublicKey(SECRET)).toString("base64url") });

let relay: RelayHandle | undefined;
afterEach(async () => {
  await relay?.close();
  relay = undefined;
  delete process.env.ACCESS_TOKEN_PUBLIC_KEYS;
});

const TOKEN_CONFIG: Partial<RelayConfig> = {
  access: { mode: "token", audience: "127.0.0.1" },
};

describe("access policy + abuse limits (docs/10)", () => {
  it("token mode denies without a token (403 access denied)", async () => {
    process.env.ACCESS_TOKEN_PUBLIC_KEYS = KEYS;
    relay = await startRelay({ config: TOKEN_CONFIG, port: 0, adminPort: undefined });
    await expect(TestClient.connect(relay.url, { seed: new Uint8Array(32).fill(1) })).rejects.toMatchObject({
      status: 403,
      body: "access denied",
    });
  });

  it("token mode accepts a valid minted token; wrong audience denied", async () => {
    process.env.ACCESS_TOKEN_PUBLIC_KEYS = KEYS;
    relay = await startRelay({ config: TOKEN_CONFIG, port: 0, adminPort: undefined });
    const { mintAccessToken } = await import("@cairn/core");
    const seed = new Uint8Array(32).fill(2);
    const endpoint = (await import("@cairn/core")).endpointIdFromBytes(ed25519PublicKey(seed));
    const token = mintAccessToken(
      {
        v: 1,
        kid: "dev",
        sub: endpoint,
        aud: "127.0.0.1",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
      },
      SECRET,
    );
    const client = await TestClient.connect(relay.url, { seed, accessToken: token });
    await client.nextFrameOfType("serverInfo");
    client.close(1000);

    const wrongAud = mintAccessToken(
      {
        v: 1,
        kid: "dev",
        sub: endpoint,
        aud: "other.net",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
      },
      SECRET,
    );
    await expect(TestClient.connect(relay.url, { seed, accessToken: wrongAud })).rejects.toMatchObject({
      status: 403,
    });
  });

  it("per-IP upgrade limit: 429 beyond 60 upgrades/minute", async () => {
    relay = await startRelay({
      config: { access: { mode: "open" }, maxConnectionsPerEndpoint: 100 },
      port: 0,
      adminPort: undefined,
    });
    const seedBase = new Uint8Array(32);
    let rejected = 0;
    for (let i = 0; i < 75; i++) {
      seedBase.set([i & 0xff, (i >> 8) & 0xff], 30);
      try {
        const c = await TestClient.connect(relay.url, { seed: seedBase.slice() });
        c.close(1000);
      } catch {
        rejected += 1;
      }
    }
    expect(rejected).toBeGreaterThan(0);
  }, 60_000);
});
