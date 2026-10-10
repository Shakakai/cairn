/**
 * WebSocket upgrade negotiation (doc 01 §3.1, docs/02). Pure decision function: validates the
 * HTTP surface, the subprotocol, and the auth blob (checks 1–4 of doc 01 §3.2). Replay,
 * access policy and draining are adapter/Router concerns that run after this resolves.
 */

import { AUTH_BLOB_LENGTH, decodeBase64Url, verifyAuthBlob } from "./auth.js";
import type { Env } from "./config.js";
import { CONNECT_PATH, PROTOCOL_VERSION_TOKEN } from "./http.js";
import type { EndpointId } from "./keys.js";

export interface UpgradeRequest {
  method: string;
  path: string;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  query: Record<string, string>;
}

export type UpgradeDecision =
  | {
      ok: true;
      endpoint: EndpointId;
      endpointBytes: Uint8Array;
      nonce: Uint8Array;
      subprotocol: typeof PROTOCOL_VERSION_TOKEN;
      token?: string;
    }
  | { ok: false; status: 400 | 401 | 404 | 426; headers: Record<string, string>; body: string };

const reject = (
  status: 400 | 401 | 404 | 426,
  body: string,
  headers: Record<string, string> = {},
): UpgradeDecision => ({ ok: false, status, headers, body });

function isWebSocketUpgrade(headers: Record<string, string>): boolean {
  const connection = headers["connection"];
  const upgrade = headers["upgrade"];
  if (upgrade === undefined || upgrade.toLowerCase() !== "websocket") return false;
  // `Connection` is a list; any token matching "upgrade" (case-insensitive) suffices.
  return connection !== undefined && connection.split(",").some((t) => t.trim().toLowerCase() === "upgrade");
}

function offeredSubprotocols(headers: Record<string, string>): string[] {
  const header = headers["sec-websocket-protocol"];
  if (header === undefined) return [];
  return header
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Steps 1–4 of doc 01 §3.1 in order. `env.nowMs` provides the clock for freshness;
 * `env.config.authSkewMs` the skew.
 */
export function negotiateUpgrade(req: UpgradeRequest, env: Env): UpgradeDecision {
  // Anything but the connect path isn't ours.
  if (req.path !== CONNECT_PATH) {
    return reject(404, "not found");
  }

  // Step 1: GET, websocket upgrade, key present.
  if (req.method.toUpperCase() !== "GET" || !isWebSocketUpgrade(req.headers)) {
    return reject(400, "expected websocket upgrade");
  }
  if (req.headers["sec-websocket-key"] === undefined || req.headers["sec-websocket-key"] === "") {
    return reject(400, "missing Sec-WebSocket-Key");
  }

  // Step 2: version 13 only.
  if (req.headers["sec-websocket-version"] !== "13") {
    return reject(426, "unsupported websocket version", { "Sec-WebSocket-Version": "13" });
  }

  // Step 3: subprotocol must offer switchback.v1.
  if (!offeredSubprotocols(req.headers).includes(PROTOCOL_VERSION_TOKEN)) {
    return reject(400, `unsupported protocol version; supported: ${PROTOCOL_VERSION_TOKEN}`);
  }

  // Step 4: auth blob (header preferred; `?auth=` is the browser path, doc 01 §3).
  const authText = req.headers["switchback-auth"] ?? req.query["auth"];
  if (authText === undefined || authText === "") {
    return reject(401, "auth: missing");
  }
  let blobBytes: Uint8Array;
  try {
    blobBytes = decodeBase64Url(authText);
  } catch {
    return reject(401, "auth: malformed");
  }
  if (blobBytes.length !== AUTH_BLOB_LENGTH) {
    return reject(401, "auth: malformed");
  }

  const host = req.headers["host"];
  if (host === undefined || host === "") {
    return reject(400, "missing Host");
  }
  const verified = verifyAuthBlob(blobBytes, host, env.nowMs, env.config.authSkewMs);
  if (!verified.ok) {
    return reject(401, `auth: ${verified.reason}`);
  }

  // Access token: header preferred; `?token=` is the browser path (doc 01 §3.3).
  let token: string | undefined;
  const authorization = req.headers["authorization"];
  if (authorization !== undefined && authorization.toLowerCase().startsWith("bearer ")) {
    token = authorization.slice("bearer ".length).trim();
  } else if (req.query["token"] !== undefined && req.query["token"] !== "") {
    token = req.query["token"];
  }

  return {
    ok: true,
    endpoint: verified.endpoint,
    endpointBytes: verified.endpointBytes,
    nonce: verified.nonce,
    subprotocol: PROTOCOL_VERSION_TOKEN,
    ...(token !== undefined ? { token } : {}),
  };
}
