/**
 * Conformance harness (docs/04): a `Router` implementation that speaks to the Mailbox
 * Durable Object directly — owner sockets for registration/notices/delivery, link sockets
 * for routing, DO RPC for nonce claims. Runs under `@cloudflare/vitest-pool-workers`.
 */

import type { ConnRef, EndpointId, Router, SocketHost } from "@cairn/core";
import type { Env } from "../types.js";

const connKeyOf = (c: ConnRef): string => `${c.host}|${c.id}`;

export class CloudflareRouter implements Router {
  private readonly owners = new Map<string, WebSocket>(); // connKey -> owner socket
  private readonly links = new Map<string, WebSocket>(); // endpoint -> link socket

  constructor(
    private readonly bindings: Env,
    private readonly host: SocketHost,
  ) {}

  async register(endpoint: EndpointId, conn: ConnRef): Promise<void> {
    const stub = this.stub(endpoint);
    const response = await stub.fetch("https://mailbox/owner", {
      headers: { Upgrade: "websocket", "x-conn": connKeyOf(conn) },
    });
    if (response.status !== 101 || response.webSocket === null) {
      throw new Error(`mailbox /owner failed: ${response.status}`);
    }
    const owner = response.webSocket;
    this.owners.set(connKeyOf(conn), owner);
    owner.accept();
    owner.addEventListener("message", (ev: MessageEvent) => {
      if (typeof ev.data === "string") {
        const notice = (
          JSON.parse(ev.data as string) as { n?: "becameActive" | "becameInactive" | "promoted" }
        ).n;
        if (notice !== undefined) {
          this.host.notify(conn, notice);
        }
      } else {
        const bytes =
          ev.data instanceof ArrayBuffer
            ? new Uint8Array(ev.data)
            : new Uint8Array((ev.data as ArrayBufferView).buffer);
        this.host.deliver(conn, bytes);
      }
    });
    owner.send(JSON.stringify({ t: "ready" }));
  }

  async unregister(_endpoint: EndpointId, conn: ConnRef, sentTo: EndpointId[]): Promise<void> {
    const owner = this.owners.get(connKeyOf(conn));
    if (owner !== undefined) {
      try {
        owner.send(JSON.stringify({ t: "bye", sentTo }));
        owner.close(1000, "bye");
      } catch {
        // already closed
      }
      this.owners.delete(connKeyOf(conn));
    }
  }

  async route(dst: EndpointId, frame: Uint8Array): Promise<"delivered" | "offline"> {
    let link: WebSocket | undefined = this.links.get(dst) ?? undefined;
    if (link === undefined || link.readyState !== WebSocket.OPEN) {
      const response = await this.stub(dst).fetch("https://mailbox/link", {
        headers: { Upgrade: "websocket" },
      });
      if (response.status !== 101 || response.webSocket === null) {
        return "offline";
      }
      link = response.webSocket;
      this.links.set(dst, link);
      link.accept();
    }
    try {
      link.send(frame);
      return "delivered";
    } catch {
      return "offline";
    }
  }

  async claimNonce(endpoint: EndpointId, nonce: Uint8Array, ttlMs: number): Promise<boolean> {
    return (
      this.stub(endpoint) as unknown as {
        claimNonceForTests(nonce: number[], ttlMs: number): Promise<boolean>;
      }
    ).claimNonceForTests(Array.from(nonce), ttlMs);
  }

  localActive(_dst: EndpointId): ConnRef | undefined {
    return undefined; // cross-socket delivery goes through the mailbox
  }

  async close(): Promise<void> {
    for (const ws of this.owners.values()) {
      try {
        ws.close(1000, "router close");
      } catch {
        // ignore
      }
    }
    for (const ws of this.links.values()) {
      try {
        ws.close(1000, "router close");
      } catch {
        // ignore
      }
    }
    this.owners.clear();
    this.links.clear();
  }

  private stub(endpoint: EndpointId) {
    return this.bindings.MAILBOX.get(this.bindings.MAILBOX.idFromName(endpoint));
  }
}
