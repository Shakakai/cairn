import { hostConformance } from "@cairn/conformance";
import { startRelay } from "../src/relay.js";

hostConformance({
  name: "node-memory",
  start: async () => {
    const relay = await startRelay({
      config: {
        access: { mode: "open" },
        abuse: { upgradesPerMinute: 1_000_000, authFailuresPerMinute: 1_000_000, blockMs: 1_000 },
        region: "test",
      },
      port: 0,
      adminPort: 0,
    });
    return { url: relay.url, close: () => relay.close() };
  },
});
