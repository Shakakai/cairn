#!/usr/bin/env bash
# Host conformance + e2e against `wrangler dev` (real workerd) — the M5 local acceptance
# path for the Cloudflare adapter (docs/08 §3). Usage: scripts/test-cf-host.sh [scenario]
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=8787
URL="ws://127.0.0.1:${PORT}"

cd packages/adapter-cloudflare
pnpm wrangler dev --port "$PORT" > /tmp/cairn-wrangler-dev.log 2>&1 &
WRANGLER_PID=$!
cd ../..
trap 'kill $WRANGLER_PID 2>/dev/null || true' EXIT

for i in $(seq 1 90); do
  if curl -sf "http://127.0.0.1:${PORT}/healthz" > /dev/null 2>&1; then break; fi
  sleep 1
done
curl -sf "http://127.0.0.1:${PORT}/healthz" > /dev/null

WRANGLER_DEV_URL="$URL" pnpm --filter @cairn/adapter-cloudflare exec vitest run test/host.spec.ts
cargo run -p e2e -- --cairn "$URL" --scenario "${1:-smoke}"
