/**
 * HTTP surface of a Cairn deployment (doc 01 §2), as pure response descriptors. Adapters map
 * these onto their platform's response type; nothing here performs I/O.
 */

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export const PROTOCOL_VERSION_TOKEN = "switchback.v1";
export const CONNECT_PATH = "/v1/connect";
export const PING_PATH = "/v1/ping";
export const CAPTIVE_PATH = "/v1/captive";
export const HEALTHZ_PATH = "/healthz";
export const ROBOTS_PATH = "/robots.txt";

const CAPTIVE_CHALLENGE_PATTERN = /^[A-Za-z0-9]{16,32}$/;

function text(status: number, body: string, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers, body };
}

export interface HealthInfo {
  /** Server semver, e.g. "0.1.0". */
  version: string;
  /** VCS commit sha, e.g. from CI. */
  commit: string;
}

export interface HttpRequest {
  method: string;
  path: string;
  /** Lower-cased header names. */
  headers: Record<string, string>;
}

/**
 * Route one HTTP request. WebSocket upgrades are handled by `negotiateUpgrade` (doc 01 §3);
 * this covers everything else on the surface, including a bare `GET /v1/connect` without
 * upgrade headers (400 per doc 01 §3.1 step 1).
 */
export function routeHttp(req: HttpRequest, info: HealthInfo): HttpResponse {
  const method = req.method.toUpperCase();

  if (req.path === PING_PATH) {
    if (method !== "GET") return text(404, "not found");
    // Liveness: fast path only, no auth, no storage (doc 01 §2.2).
    return text(204, "", { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
  }

  if (req.path === CAPTIVE_PATH) {
    if (method !== "GET") return text(404, "not found");
    // Captive-portal detection (doc 01 §2.1): always 204; echo a valid challenge.
    const challenge = req.headers["switchback-challenge"];
    if (challenge !== undefined && CAPTIVE_CHALLENGE_PATTERN.test(challenge)) {
      return text(204, "", { "Switchback-Response": challenge });
    }
    return text(204, "");
  }

  if (req.path === HEALTHZ_PATH) {
    if (method !== "GET") return text(404, "not found");
    const body = JSON.stringify({
      status: "ok",
      version: info.version,
      commit: info.commit,
      protocols: [PROTOCOL_VERSION_TOKEN],
    });
    return text(200, body, { "Content-Type": "application/json" });
  }

  if (req.path === ROBOTS_PATH) {
    if (method !== "GET") return text(404, "not found");
    return text(200, "User-agent: *\nDisallow: /\n", { "Content-Type": "text/plain" });
  }

  return text(404, "not found");
}
