/**
 * Host conformance against a live `wrangler dev` process (docs/08 §3). Skipped unless
 * WRANGLER_DEV_URL is set; driven by scripts/test-cf-host.sh locally and in CI.
 */

import { hostConformance } from "@cairn/conformance";
import { describe, it } from "vitest";

const url = process.env.WRANGLER_DEV_URL;

if (url !== undefined && url !== "") {
  hostConformance({
    name: "cloudflare-worker",
    replayClosesWith1008: true,
    start: async () => ({
      url,
      close: async () => {
        // wrangler dev is managed by the caller (script/CI step).
      },
    }),
  });
} else {
  describe("host conformance: cloudflare-worker", () => {
    it.skip("set WRANGLER_DEV_URL to run against wrangler dev", () => {});
  });
}
