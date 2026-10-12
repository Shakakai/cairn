/**
 * Access policy (docs/01 §3.3, 10): `open` allows any endpoint with a valid auth blob;
 * `token` additionally requires an access token valid for this endpoint, verified
 * against the deployment's ACCESS_TOKEN_PUBLIC_KEYS map. The map arrives as a JSON
 * object kid -> base64 Ed25519 public key (env / secret), parsed once.
 */

import { type EndpointId, type RelayConfig, type TokenPublicKeys, verifyAccessToken } from "@cairn/core";

export interface AccessPolicy {
  allow(endpoint: EndpointId, token: string | undefined, audience: string): Promise<boolean>;
}

export function parseTokenPublicKeys(raw: string | undefined): TokenPublicKeys {
  if (raw === undefined || raw === "") return {};
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("ACCESS_TOKEN_PUBLIC_KEYS must be a JSON object kid -> base64 public key");
  }
  return parsed as TokenPublicKeys;
}

export function makeAccessPolicy(
  config: RelayConfig,
  publicKeys: TokenPublicKeys,
  log: (msg: string) => void,
): AccessPolicy {
  if (config.access.mode === "open") {
    return { allow: () => Promise.resolve(true) };
  }
  if (Object.keys(publicKeys).length === 0) {
    log("access.mode=token but ACCESS_TOKEN_PUBLIC_KEYS is empty; all connections will be denied");
  }
  return {
    allow(endpoint, token, audience) {
      if (token === undefined) return Promise.resolve(false);
      const nowSec = Math.floor(Date.now() / 1000);
      const result = verifyAccessToken(token, endpoint, audience, nowSec, publicKeys);
      return Promise.resolve(result.ok);
    },
  };
}
