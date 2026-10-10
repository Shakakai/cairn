/**
 * In-process Router (docs/03): per-endpoint maps driven by the pure `core.registryStep`
 * reducer, a `NonceCache` for replay protection, and direct `SocketHost` callbacks for
 * notices, closes and delivery. Used single-node and in tests.
 */

import {
  type ConnRef,
  type EndpointEntry,
  type EndpointId,
  encode,
  endpointIdToBytes,
  NonceCache,
  type RegistryOptions,
  type Router,
  registryStep,
  type SocketHost,
} from "@cairn/core";

export interface MemoryRouterOptions {
  /** maxConnectionsPerEndpoint (doc 10). Default 4. */
  maxConnectionsPerEndpoint?: number;
  /** Bound of each endpoint's merged sent-to union (doc 10). Default 4096. */
  sentToMax?: number;
  /** Capacity of the (endpoint, nonce) replay cache. Default 100 000. */
  nonceCacheCapacity?: number;
  /** Clock injection for tests; defaults to Date.now. */
  now?: () => number;
}

export class MemoryRouter implements Router {
  private readonly entries = new Map<EndpointId, EndpointEntry>();
  private readonly nonces: NonceCache;
  private readonly registryOptions: RegistryOptions;
  private readonly now: () => number;

  constructor(
    private readonly host: SocketHost,
    options: MemoryRouterOptions = {},
  ) {
    this.registryOptions = {
      ...(options.maxConnectionsPerEndpoint !== undefined
        ? { maxConnections: options.maxConnectionsPerEndpoint }
        : {}),
      ...(options.sentToMax !== undefined ? { sentToMax: options.sentToMax } : {}),
    };
    this.nonces = new NonceCache(options.nonceCacheCapacity ?? 100_000);
    this.now = options.now ?? (() => Date.now());
  }

  async register(endpoint: EndpointId, conn: ConnRef): Promise<void> {
    const { entry, out } = registryStep(
      endpoint,
      this.entries.get(endpoint),
      { op: "register", conn },
      this.registryOptions,
    );
    this.applyEntry(endpoint, entry);
    this.applyOut(out);
  }

  async unregister(endpoint: EndpointId, conn: ConnRef, sentTo: EndpointId[]): Promise<void> {
    const { entry, out } = registryStep(
      endpoint,
      this.entries.get(endpoint),
      { op: "unregister", conn, sentTo },
      this.registryOptions,
    );
    this.applyEntry(endpoint, entry);
    this.applyOut(out);
  }

  async route(dst: EndpointId, frame: Uint8Array): Promise<"delivered" | "offline"> {
    const entry = this.entries.get(dst);
    if (entry?.active === undefined) return "offline";
    // Per-pair order: delivers for one connection are serialized by the SocketHost.
    this.host.deliver(entry.active, frame);
    return "delivered";
  }

  async claimNonce(endpoint: EndpointId, nonce: Uint8Array, ttlMs: number): Promise<boolean> {
    return this.nonces.claim(endpoint, nonce, ttlMs, this.now());
  }

  localActive(dst: EndpointId): ConnRef | undefined {
    return this.entries.get(dst)?.active;
  }

  /** Number of endpoints currently registered (metrics/tests). */
  get endpointCount(): number {
    return this.entries.size;
  }

  async close(): Promise<void> {
    this.entries.clear();
  }

  private applyEntry(endpoint: EndpointId, entry: EndpointEntry | undefined): void {
    if (entry === undefined) {
      this.entries.delete(endpoint);
    } else {
      this.entries.set(endpoint, entry);
    }
  }

  private applyOut(out: ReturnType<typeof registryStep>["out"]): void {
    for (const o of out) {
      if ("notify" in o) {
        this.host.notify(o.notify, o.notice);
      } else if ("close" in o) {
        this.host.close(o.close, o.code, "too many connections for endpoint");
      } else if ("gone" in o) {
        this.fanOutGone(o.gone.endpoint, o.gone.notifyEndpoints);
      }
      // deleteEntry is realized by applyEntry.
    }
  }

  /** Each online member of the departed endpoint's sent-to union gets PeerGone once. */
  private fanOutGone(endpoint: EndpointId, notifyEndpoints: EndpointId[]): void {
    const frame = encode.peerGone(endpointIdToBytes(endpoint));
    for (const target of notifyEndpoints) {
      const entry = this.entries.get(target);
      if (entry?.active !== undefined) {
        this.host.deliver(entry.active, frame);
      }
    }
  }
}
