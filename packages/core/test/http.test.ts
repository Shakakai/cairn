import { describe, expect, it } from "vitest";
import { type HttpRequest, routeHttp } from "../src/index.js";

const INFO = { version: "0.1.0", commit: "deadbee" };

function req(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return { method: "GET", path: "/v1/ping", headers: {}, ...overrides };
}

describe("HTTP surface (doc 01 §2)", () => {
  it("/v1/ping: 204 with no-store and CORS headers", () => {
    expect(routeHttp(req(), INFO)).toEqual({
      status: 204,
      headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
      body: "",
    });
  });

  it("/v1/captive: echoes a valid challenge, always 204", () => {
    const ok = routeHttp(
      req({ path: "/v1/captive", headers: { "switchback-challenge": "abcdefgh12345678" } }),
      INFO,
    );
    expect(ok).toEqual({
      status: 204,
      headers: { "Switchback-Response": "abcdefgh12345678" },
      body: "",
    });

    // Invalid challenge tokens are not echoed.
    const bad = routeHttp(req({ path: "/v1/captive", headers: { "switchback-challenge": "short" } }), INFO);
    expect(bad).toEqual({ status: 204, headers: {}, body: "" });

    const noHeader = routeHttp(req({ path: "/v1/captive" }), INFO);
    expect(noHeader.status).toBe(204);
  });

  it("/healthz: JSON with protocols list", () => {
    const res = routeHttp(req({ path: "/healthz" }), INFO);
    expect(res.status).toBe(200);
    expect(res.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(res.body)).toEqual({
      status: "ok",
      version: "0.1.0",
      commit: "deadbee",
      protocols: ["switchback.v1"],
    });
  });

  it("/robots.txt: disallow-all", () => {
    const res = routeHttp(req({ path: "/robots.txt" }), INFO);
    expect(res.status).toBe(200);
    expect(res.body).toBe("User-agent: *\nDisallow: /\n");
  });

  it("anything else: 404", () => {
    expect(routeHttp(req({ path: "/nope" }), INFO).status).toBe(404);
    expect(routeHttp(req({ path: "/v1/connect" }), INFO).status).toBe(404);
  });

  it("non-GET methods on known paths: 404", () => {
    expect(routeHttp(req({ path: "/v1/ping", method: "POST" }), INFO).status).toBe(404);
  });
});
