/**
 * Cairn Pool entry point (doc 05): load config, build the relay, wire SIGTERM drain.
 */

import { loadConfig } from "./config.js";
import { instanceId } from "./platform.js";
import { startRelay } from "./relay.js";

const config = loadConfig();
const hostId = process.env.INSTANCE_ID ?? (await instanceId());

const relay = await startRelay({ config, hostId, adminPort: config.ports.admin });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ ts: Date.now(), msg: "shutdown", signal }));
  relay.drain();
  // Let the drain window play out, then close hard.
  setTimeout(() => {
    relay
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  }, config.drainWindowMs + 1_000);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

console.log(JSON.stringify({ ts: Date.now(), msg: "cairn ready", url: relay.url, admin: relay.adminUrl }));
