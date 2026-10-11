/**
 * Load and validate `RELAY_CONFIG` (JSON) or `RELAY_CONFIG_FILE` (docs/07, 10).
 * Unknown keys are an error (core validateRelayConfig).
 */

import { readFileSync } from "node:fs";
import { type RelayConfig, validateRelayConfig } from "@cairn/core";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  let raw: string | undefined;
  if (env.RELAY_CONFIG !== undefined && env.RELAY_CONFIG !== "") {
    raw = env.RELAY_CONFIG;
  } else if (env.RELAY_CONFIG_FILE !== undefined && env.RELAY_CONFIG_FILE !== "") {
    raw = readFileSync(env.RELAY_CONFIG_FILE, "utf8");
  }
  const parsed = raw === undefined ? {} : (JSON.parse(raw) as unknown);
  return validateRelayConfig(parsed);
}
