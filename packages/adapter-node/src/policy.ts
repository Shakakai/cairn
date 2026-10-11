/**
 * Access policy (docs/10): `open` allows any endpoint with a valid auth blob; `token`
 * requires a verified access token — token verification lands in M8 (`core/tokens.ts`),
 * until then token mode denies with 403 (and logs that the mode needs configuration).
 */

import type { EndpointId, RelayConfig } from "@cairn/core";

export interface AccessPolicy {
  allow(endpoint: EndpointId, token?: string): Promise<boolean>;
}

export function makeAccessPolicy(config: RelayConfig, log: (msg: string) => void): AccessPolicy {
  if (config.access.mode === "open") {
    return { allow: () => Promise.resolve(true) };
  }
  return {
    allow: () => {
      log("access.mode=token: no token verification yet (M8); denying connection");
      return Promise.resolve(false);
    },
  };
}
