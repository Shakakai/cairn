/**
 * Black-box host conformance suite (docs/08 §3): runs over a real WebSocket against any
 * started Cairn host — adapter-node (M3), adapter-node ×2 + Redis (M6), wrangler dev (M5).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestClient, UpgradeRejectedError } from "./client.js";

export interface StartedHost {
  /** ws:// base url of the relay. */
  url: string;
  close(): Promise<void>;
}

export interface HostConformanceOptions {
  /** Extra config context for test titles. */
  name: string;
  start: () => Promise<StartedHost>;
  /**
   * Platforms that detect replay after the WebSocket is accepted (Cloudflare, doc 01
   * §3.1) close the accepted socket with 1008 instead of rejecting the upgrade with 401.
   */
  replayClosesWith1008?: boolean;
}

const seed = (b: number): Uint8Array => new Uint8Array(32).fill(b);

export function hostConformance(options: HostConformanceOptions): void {
  describe(`host conformance: ${options.name}`, () => {
    let host: StartedHost;

    beforeAll(async () => {
      host = await options.start();
    }, 30_000);

    afterAll(async () => {
      await host.close();
    }, 30_000);

    it("connects with valid auth: 101, subprotocol, ServerInfo first", async () => {
      const client = await TestClient.connect(host.url, { seed: seed(1) });
      expect(client.protocol).toBe("switchback.v1");
      const first = await client.nextFrame();
      expect(first.type).toBe("serverInfo");
      if (first.type === "serverInfo") {
        expect(first.maxPayload).toBe(65_536);
      }
      client.close(1000);
    });

    it("rejects wrong subprotocol with 400 and the exact body", async () => {
      await expect(
        TestClient.connect(host.url, { seed: seed(2), protocols: ["other.v9"] }),
      ).rejects.toMatchObject({
        status: 400,
        body: "unsupported protocol version; supported: switchback.v1",
      });
    });

    it("rejects missing auth with 401 auth: missing", async () => {
      await expect(TestClient.connect(host.url, { seed: seed(3), omitAuth: true })).rejects.toMatchObject({
        status: 401,
        body: "auth: missing",
      });
    });

    it("rejects stale auth with 401 auth: stale", async () => {
      await expect(
        TestClient.connect(host.url, { seed: seed(4), timestampMs: Date.now() - 10 * 60_000 }),
      ).rejects.toMatchObject({ status: 401, body: "auth: stale" });
    });

    it("rejects replayed nonces", async () => {
      const nonce = new Uint8Array(16).fill(0x5c);
      const c1 = await TestClient.connect(host.url, { seed: seed(5), nonce });
      c1.close(1000);
      await c1.waitForClose();
      if (options.replayClosesWith1008 === true) {
        // doc 01 §3.1: on Cloudflare replay is detected after accept: the relay closes
        // the socket with 1008 right after acceptance.
        const c2 = await TestClient.connect(host.url, { seed: seed(5), nonce });
        const close = await c2.waitForClose(10_000);
        expect(close.code).toBe(1008);
      } else {
        await expect(TestClient.connect(host.url, { seed: seed(5), nonce })).rejects.toMatchObject({
          status: 401,
          body: "auth: replay",
        });
      }
    });

    it("relays Send→Recv and SendBatch→RecvBatch between endpoints", async () => {
      const a = await TestClient.connect(host.url, { seed: seed(6) });
      const b = await TestClient.connect(host.url, { seed: seed(7) });
      await a.nextFrameOfType("serverInfo");
      await b.nextFrameOfType("serverInfo");

      a.sendDatagram(b.endpointBytes, 2, new Uint8Array([1, 2, 3]));
      const recv = await b.nextFrameOfType("recv");
      expect(recv.src).toEqual(a.endpointBytes);
      expect(recv.ecn).toBe(2);
      expect(recv.datagram).toEqual(new Uint8Array([1, 2, 3]));

      a.sendBatch(b.endpointBytes, 0, 4, new Uint8Array([9, 9, 9, 9, 8, 8]));
      const batch = await b.nextFrameOfType("recvBatch");
      expect(batch.src).toEqual(a.endpointBytes);
      expect(batch.segmentSize).toBe(4);
      expect(batch.datagrams).toEqual(new Uint8Array([9, 9, 9, 9, 8, 8]));

      a.close(1000);
      b.close(1000);
    });

    it("empty datagrams relay fine", async () => {
      const a = await TestClient.connect(host.url, { seed: seed(8) });
      const b = await TestClient.connect(host.url, { seed: seed(9) });
      await a.nextFrameOfType("serverInfo");
      await b.nextFrameOfType("serverInfo");
      a.sendDatagram(b.endpointBytes, 0, new Uint8Array(0));
      const recv = await b.nextFrameOfType("recv");
      expect(recv.datagram).toEqual(new Uint8Array(0));
      a.close(1000);
      b.close(1000);
    });

    it("displacement: newest connection wins; closing it promotes the older one", async () => {
      const first = await TestClient.connect(host.url, { seed: seed(10) });
      await first.nextFrameOfType("serverInfo");
      // Own registration produces Status(0 Active) first.
      expect((await first.nextFrameOfType("status")).code).toBe(0);
      const second = await TestClient.connect(host.url, { seed: seed(10) });
      await second.nextFrameOfType("serverInfo");
      expect((await second.nextFrameOfType("status")).code).toBe(0);

      const displaced = await first.nextFrameOfType("status");
      expect(displaced.code).toBe(1); // Displaced

      // Traffic goes to the second connection.
      const sender = await TestClient.connect(host.url, { seed: seed(11) });
      await sender.nextFrameOfType("serverInfo");
      sender.sendDatagram(second.endpointBytes, 0, new Uint8Array([7]));
      const got = await second.nextFrameOfType("recv");
      expect(got.datagram).toEqual(new Uint8Array([7]));

      // Closing the active connection promotes the first.
      second.close(1000);
      const promoted = await first.nextFrameOfType("status");
      expect(promoted.code).toBe(0); // Active

      first.close(1000);
      sender.close(1000);
    });

    it("PeerGone arrives once when a peer fully leaves", async () => {
      const a = await TestClient.connect(host.url, { seed: seed(12) });
      const b = await TestClient.connect(host.url, { seed: seed(13) });
      await a.nextFrameOfType("serverInfo");
      await b.nextFrameOfType("serverInfo");
      a.sendDatagram(b.endpointBytes, 0, new Uint8Array([1]));
      await b.nextFrameOfType("recv");
      a.close(1000);
      const gone = await b.nextFrameOfType("peerGone", 10_000);
      expect(gone.peer).toEqual(a.endpointBytes);
      b.close(1000);
    });

    it("bad client frames close the connection with 1002", async () => {
      const client = await TestClient.connect(host.url, { seed: seed(14) });
      await client.nextFrameOfType("serverInfo");
      client.sendRaw(new Uint8Array([0x09])); // unknown client frame type
      const close = await client.waitForClose();
      expect(close.code).toBe(1002);
    });

    it("sending to an offline endpoint drops silently (no error frame)", async () => {
      const a = await TestClient.connect(host.url, { seed: seed(15) });
      await a.nextFrameOfType("serverInfo");
      const offline = TestClient.connect(host.url, { seed: seed(16) });
      const offlineClient = await offline;
      await offlineClient.nextFrameOfType("serverInfo");
      offlineClient.terminate(); // hard disconnect; unregister may lag
      await new Promise((r) => setTimeout(r, 200));
      a.sendDatagram(offlineClient.endpointBytes, 0, new Uint8Array([1]));
      // The sender stays connected and receives nothing back.
      await new Promise((r) => setTimeout(r, 300));
      expect(a.readyState).toBe(1); // WebSocket.OPEN
      a.close(1000);
    });

    it("HTTP probes: /v1/ping, /v1/captive, /healthz", async () => {
      const base = host.url.replace("ws://", "http://");
      const ping = await fetch(`${base}/v1/ping`);
      expect(ping.status).toBe(204);
      expect(ping.headers.get("cache-control")).toBe("no-store");

      const captive = await fetch(`${base}/v1/captive`, {
        headers: { "Switchback-Challenge": "abcdefgh12345678" },
      });
      expect(captive.status).toBe(204);
      expect(captive.headers.get("switchback-response")).toBe("abcdefgh12345678");

      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(200);
      const body = (await health.json()) as { status: string; protocols: string[] };
      expect(body.status).toBe("ok");
      expect(body.protocols).toEqual(["switchback.v1"]);
    });

    it("make-before-break works: second connection displaces the first quietly", async () => {
      // The newer connection sees no Displaced; the older one does and can close.
      const oldConn = await TestClient.connect(host.url, { seed: seed(17) });
      await oldConn.nextFrameOfType("serverInfo");
      expect((await oldConn.nextFrameOfType("status")).code).toBe(0);
      const newConn = await TestClient.connect(host.url, { seed: seed(17) });
      await newConn.nextFrameOfType("serverInfo");
      expect((await newConn.nextFrameOfType("status")).code).toBe(0);
      const status = await oldConn.nextFrameOfType("status");
      expect(status.code).toBe(1);
      oldConn.close(1000, "displaced cleanup");
      newConn.close(1000);
    });
  });
}

// Re-exported for suites that build their own assertions.
export { TestClient, UpgradeRejectedError };
