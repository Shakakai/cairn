/**
 * Router conformance under Miniflare (docs/03, 04): the nine Router semantics run against
 * the Mailbox Durable Object through real Worker→DO sockets.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Env } from "../src/types.js";

const bindings = env as unknown as Env;

describe("mailbox unit behaviour", () => {
  it("nonce replay: /owner with a repeated nonce returns 409", async () => {
    const stub = bindings.MAILBOX.get(bindings.MAILBOX.idFromName("nonce-test-endpoint"));
    const nonce = b64(new Uint8Array(16).fill(0x7e));
    const open = () =>
      stub.fetch("https://mailbox/owner", {
        headers: {
          Upgrade: "websocket",
          "x-conn": `h|${crypto.randomUUID()}`,
          "x-nonce": nonce,
          "x-nonce-ttl": "120000",
        },
      });
    const first = await open();
    expect(first.status).toBe(101);
    first.webSocket?.accept();
    first.webSocket?.close(1000, "done");
    const second = await open();
    expect(second.status).toBe(409);
  });

  // Binary forwarding through the local plugin runtime is unreliable (alpha); the
  // verbatim path is covered by the host conformance relay tests on wrangler dev.
  it.skip("link frames reach the active owner verbatim (covered on wrangler dev)", async () => {
    const endpoint = "link-test-endpoint";
    const stub = bindings.MAILBOX.get(bindings.MAILBOX.idFromName(endpoint));
    const ownerRes = await stub.fetch("https://mailbox/owner", {
      headers: { Upgrade: "websocket", "x-conn": "h|owner-1" },
    });
    const owner = ownerRes.webSocket;
    expect(owner).not.toBeNull();
    owner.accept();
    // Ready handshake (ADR-015): buffered notices/frames flush once the owner sends it.
    owner.send(JSON.stringify({ t: "ready" }));

    const linkRes = await stub.fetch("https://mailbox/link", {
      headers: { Upgrade: "websocket" },
    });
    const link = linkRes.webSocket;
    if (link === null) throw new Error("no link socket");
    link.accept();

    const received = new Promise<MessageEvent>((resolve) => {
      const handler = (ev: MessageEvent): void => {
        if (ev.data instanceof ArrayBuffer) {
          owner.removeEventListener("message", handler);
          resolve(ev);
        }
      };
      owner.addEventListener("message", handler);
    });
    const payload = new Uint8Array([0x04, ...new Uint8Array(32).fill(1), 2, 9, 9, 9]);
    link.send(payload);
    const event = await received;
    const data = event.data as ArrayBuffer;
    expect(new Uint8Array(data)).toEqual(payload);

    owner.close(1000, "done");
    link.close(1000, "done");
  });
});

function b64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}
