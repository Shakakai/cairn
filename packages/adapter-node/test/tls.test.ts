import { randomBytes } from "node:crypto";
import { createAuthBlob, decodeRelayFrame, ed25519PublicKey, encodeBase64Url } from "@cairn/core";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type RelayHandle, startRelay } from "../src/relay.js";

let relay: RelayHandle | undefined;
afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

describe("TLS terminate mode (doc 05)", () => {
  it("serves WSS with the configured cert", async () => {
    relay = await startRelay({
      config: {
        access: { mode: "open" },
        tls: { mode: "terminate", certFile: "/tmp/cairn-cert.pem", keyFile: "/tmp/cairn-key.pem" },
      },
      port: 0,
      adminPort: undefined,
    });
    const seed = new Uint8Array(32).fill(42);
    const endpointBytes = ed25519PublicKey(seed);
    const auth = encodeBase64Url(
      createAuthBlob({
        secretKey: seed,
        host: "127.0.0.1",
        endpointBytes,
        timestampMs: BigInt(Date.now()),
        nonce: randomBytes(16),
      }),
    );
    const ws = new WebSocket(relay.url.replace("ws://", "wss://") + "/v1/connect", ["switchback.v1"], {
      headers: { "Switchback-Auth": auth },
      rejectUnauthorized: false, // self-signed test certificate
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const first = await new Promise<Uint8Array>((resolve) => {
      ws.once("message", (data: Buffer) => resolve(new Uint8Array(data)));
    });
    expect(decodeRelayFrame(first)).toMatchObject({ type: "serverInfo" });
    ws.close(1000);
  }, 20_000);

  it("terminate mode without cert files throws at startup", async () => {
    await expect(
      startRelay({ config: { access: { mode: "open" }, tls: { mode: "terminate" } }, port: 0 }),
    ).rejects.toThrow(/tls.certFile/);
  });
});
