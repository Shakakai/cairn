import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthBlob, decodeRelayFrame, ed25519PublicKey, encodeBase64Url } from "@cairn/core";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type RelayHandle, startRelay } from "../src/relay.js";

let certFile = "";
let keyFile = "";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "cairn-tls-"));
  certFile = join(dir, "cert.pem");
  keyFile = join(dir, "key.pem");
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout "${keyFile}" -out "${certFile}" -days 1 -nodes -subj '/CN=localhost'`,
    { stdio: "ignore" },
  );
});

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
        abuse: { upgradesPerMinute: 1_000_000, authFailuresPerMinute: 1_000_000, blockMs: 1_000 },
        tls: { mode: "terminate", certFile, keyFile },
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
      startRelay({
        config: {
          access: { mode: "open" },
          abuse: { upgradesPerMinute: 1_000_000, authFailuresPerMinute: 1_000_000, blockMs: 1_000 },
          tls: { mode: "terminate" },
        },
        port: 0,
      }),
    ).rejects.toThrow(/tls.certFile/);
  });
});
