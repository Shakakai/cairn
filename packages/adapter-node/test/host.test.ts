import { hostConformance } from "@cairn/conformance";
import { startRelay } from "../src/relay.js";

hostConformance({
  name: "node-memory",
  start: async () => {
    const relay = await startRelay({
      config: { access: { mode: "open" }, region: "test" },
      port: 0,
      adminPort: 0,
    });
    return { url: relay.url, close: () => relay.close() };
  },
});
