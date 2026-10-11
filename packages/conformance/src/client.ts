/**
 * Small TypeScript protocol test client (docs/08 §3): speaks Switchback v1 over a real
 * WebSocket using `core/frames.ts` + `core/auth.ts`. Used by the host conformance suite,
 * adapter tests and (later) e2e tooling.
 */

import { randomBytes } from "node:crypto";
import {
  createAuthBlob,
  decodeRelayFrame,
  ed25519PublicKey,
  encodeBase64Url,
  endpointIdFromBytes,
  type RelayFrame,
} from "@cairn/core";
import WebSocket from "ws";

export class UpgradeRejectedError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`upgrade rejected: ${status} ${body}`);
    this.name = "UpgradeRejectedError";
  }
}

export interface ConnectOptions {
  /** 32-byte Ed25519 secret key seed; the endpoint id is derived from it. */
  seed: Uint8Array;
  /** Offered subprotocols (default ["switchback.v1"]). */
  protocols?: string[];
  /** Send auth as `?auth=` query instead of the header (browser path). */
  authInQuery?: boolean;
  accessToken?: string;
  /** Clock override for stale-auth tests. */
  timestampMs?: number;
  /** Reuse a nonce for replay tests. */
  nonce?: Uint8Array;
  /** Omit the auth blob entirely (401 auth: missing path). */
  omitAuth?: boolean;
}

export class TestClient {
  readonly endpointBytes: Uint8Array;
  readonly endpointId: string;
  private readonly ws: WebSocket;
  private frames: RelayFrame[] = [];
  private waiters: ((frame: RelayFrame) => void)[] = [];
  private closeInfo: { code: number; reason: string } | undefined;
  private closeWaiters: ((info: { code: number; reason: string }) => void)[] = [];

  private constructor(
    ws: WebSocket,
    endpointBytes: Uint8Array,
    prebuffer: { data: Buffer; isBinary: boolean }[],
  ) {
    this.ws = ws;
    this.endpointBytes = endpointBytes;
    this.endpointId = endpointIdFromBytes(endpointBytes);
    for (const { data, isBinary } of prebuffer) {
      if (isBinary) this.onMessage(new Uint8Array(data));
    }
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) this.onMessage(new Uint8Array(data));
    });
    ws.on("close", (code, reason) => {
      this.closeInfo = { code, reason: reason.toString() };
      for (const waiter of this.closeWaiters.splice(0)) waiter(this.closeInfo);
    });
  }

  private onMessage(bytes: Uint8Array): void {
    const frame = decodeRelayFrame(bytes);
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter(frame);
    } else {
      this.frames.push(frame);
    }
  }

  static async connect(relayUrl: string, options: ConnectOptions): Promise<TestClient> {
    const endpointBytes = ed25519PublicKey(options.seed);
    const url = new URL(relayUrl);
    if (url.pathname === "/") url.pathname = "/v1/connect";
    const host = url.hostname;
    const headers: Record<string, string> = {};
    if (!options.omitAuth) {
      const auth = encodeBase64Url(
        createAuthBlob({
          secretKey: options.seed,
          host,
          endpointBytes,
          timestampMs: BigInt(options.timestampMs ?? Date.now()),
          nonce: options.nonce ?? randomBytes(16),
        }),
      );
      if (options.authInQuery) {
        url.searchParams.set("auth", auth);
      } else {
        headers["Switchback-Auth"] = auth;
      }
    }
    if (options.accessToken !== undefined) headers["Authorization"] = `Bearer ${options.accessToken}`;

    const ws = new WebSocket(url.toString(), options.protocols ?? ["switchback.v1"], { headers });

    // Buffer anything that arrives before the client is constructed (ServerInfo can
    // precede the 'open' event's await continuation).
    const prebuffer: { data: Buffer; isBinary: boolean }[] = [];
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      prebuffer.push({ data, isBinary });
    });

    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("unexpected-response", (_req, res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          reject(new UpgradeRejectedError(res.statusCode ?? 0, Buffer.concat(chunks).toString()));
        });
      });
      ws.once("error", (err) => reject(err));
    });

    return new TestClient(ws, endpointBytes, prebuffer);
  }

  get protocol(): string {
    return this.ws.protocol;
  }

  /** Next decoded relay frame; buffered frames are returned before waiting. */
  nextFrame(timeoutMs = 5_000): Promise<RelayFrame> {
    const buffered = this.frames.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error("timed out waiting for a frame"));
      }, timeoutMs);
      const waiter = (frame: RelayFrame): void => {
        clearTimeout(timer);
        resolve(frame);
      };
      this.waiters.push(waiter);
    });
  }

  async nextFrameOfType<T extends RelayFrame["type"]>(
    type: T,
    timeoutMs = 5_000,
  ): Promise<Extract<RelayFrame, { type: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const frame = await this.nextFrame(Math.max(1, deadline - Date.now()));
      if (frame.type === type) return frame as Extract<RelayFrame, { type: T }>;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}`);
    }
  }

  sendDatagram(dst: Uint8Array, ecn: number, datagram: Uint8Array): void {
    const frame = new Uint8Array(1 + 32 + 1 + datagram.length);
    frame[0] = 0x02;
    frame.set(dst, 1);
    frame[33] = ecn;
    frame.set(datagram, 34);
    this.ws.send(frame);
  }

  sendBatch(dst: Uint8Array, ecn: number, segmentSize: number, datagrams: Uint8Array): void {
    const frame = new Uint8Array(1 + 32 + 1 + 2 + datagrams.length);
    frame[0] = 0x03;
    frame.set(dst, 1);
    frame[33] = ecn;
    frame[34] = (segmentSize >> 8) & 0xff;
    frame[35] = segmentSize & 0xff;
    frame.set(datagrams, 36);
    this.ws.send(frame);
  }

  sendRaw(bytes: Uint8Array): void {
    this.ws.send(bytes);
  }

  ping(): void {
    this.ws.ping();
  }

  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }

  terminate(): void {
    this.ws.terminate();
  }

  waitForClose(timeoutMs = 5_000): Promise<{ code: number; reason: string }> {
    if (this.closeInfo !== undefined) return Promise.resolve(this.closeInfo);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for close")), timeoutMs);
      this.closeWaiters.push((info) => {
        clearTimeout(timer);
        resolve(info);
      });
    });
  }

  get readyState(): number {
    return this.ws.readyState;
  }
}
