/**
 * Dev access-token CLI (docs/10): mints a signed access token for testing.
 *
 *   TOKEN_SECRET_KEY=<hex 32B> pnpm --filter @cairn/adapter-node mint-token \
 *     --kid 2026-10 --sub <endpoint z32 | *> --aud cairn.example.net --ttl 3600
 */
import { ed25519PublicKey, mintAccessToken } from "@cairn/core";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const next: string | undefined = process.argv[i + 1];
  if (i >= 0 && next !== undefined) return next;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

const secretHex = process.env.TOKEN_SECRET_KEY;
if (secretHex === undefined || secretHex === "") {
  throw new Error("set TOKEN_SECRET_KEY (64 hex chars = 32-byte Ed25519 seed)");
}
const secret = new Uint8Array(32);
for (let i = 0; i < 32; i++) {
  secret[i] = parseInt(secretHex.slice(i * 2, i * 2 + 2), 16);
}

const ttlSec = Number(arg("ttl", "3600"));
const token = mintAccessToken(
  {
    v: 1,
    kid: arg("kid", "dev"),
    sub: arg("sub", "*"),
    aud: arg("aud", "cairn.example.net"),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + ttlSec,
  },
  secret,
);

console.log(
  JSON.stringify({
    token,
    public_key_b64: Buffer.from(ed25519PublicKey(secret)).toString("base64url"),
    hint: 'set ACCESS_TOKEN_PUBLIC_KEYS=\'{"<kid>":"<public_key_b64>"}\' on the relay',
  }),
);
