/**
 * Port interfaces every server adapter implements (docs/03): `SocketHost` owns client
 * WebSockets and executes core effects; `Router` maps EndpointIds to connections across the
 * deployment. These are pure types — the core never calls them; adapters do.
 */

import type { Capabilities } from "./config.js";
import type { EndpointId } from "./keys.js";

/** Opaque handle to one client WebSocket in one SocketHost (docs/02). */
export interface ConnRef {
  host: string;
  id: string;
}

export const connKey = (c: ConnRef): string => `${c.host}|${c.id}`;

export type Notice = "becameActive" | "becameInactive" | "promoted";

/**
 * The platform side of a Cairn deployment: owns client sockets, drives the core state
 * machine for each, executes effects, and accepts Router callbacks.
 */
export interface SocketHost {
  readonly hostId: string;
  readonly caps: Capabilities;
  /** Deliver a ready relay→client frame (Recv, RecvBatch, PeerGone). Unknown/closed conn: ignore + count. */
  deliver(conn: ConnRef, frame: Uint8Array): void;
  /** Registry notices for a locally-held connection. */
  notify(conn: ConnRef, notice: Notice): void;
  /**
   * Close a locally-held connection. Used for registry evictions (1008) and any other
   * router-initiated closes (ADR-012).
   */
  close(conn: ConnRef, code: number, reason: string): void;
}

/**
 * Maps EndpointIds to connections across the deployment and moves frames between
 * SocketHosts. Semantics are pinned by `packages/conformance/router.spec.ts` (docs/03).
 */
export interface Router {
  /** Newest wins. Resolves once the registration is visible to route() from anywhere. */
  register(endpoint: EndpointId, conn: ConnRef): Promise<void>;

  /** Remove conn; promote or, if fully gone, deliver PeerGone to the sent-to union. Unknown conn: no-op. */
  unregister(endpoint: EndpointId, conn: ConnRef, sentTo: EndpointId[]): Promise<void>;

  /** Deliver a ready relay→client frame to dst's active connection. Never waits for the remote write. */
  route(dst: EndpointId, frame: Uint8Array): Promise<"delivered" | "offline">;

  /** Record (endpoint, nonce) for ttlMs. Returns false if it was already recorded (replay). */
  claimNonce(endpoint: EndpointId, nonce: Uint8Array, ttlMs: number): Promise<boolean>;

  /** If dst's active connection is held by this process, return it (local fast path). */
  localActive(dst: EndpointId): ConnRef | undefined;

  /**
   * Resolves once registrations and routes are observable by this router (e.g. the
   * pub/sub subscription is live). Adapters await this before accepting traffic.
   */
  readonly ready?: Promise<void>;

  close(): Promise<void>;
}
