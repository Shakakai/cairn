import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default {
  plugins: [
    cloudflareTest({
      wrangler: { configPath: new URL("./wrangler.jsonc", import.meta.url).pathname },
    }),
  ],
};
