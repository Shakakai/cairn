# Cairn Edge — Cloudflare deployment (docs/07)

The adapter lives in `packages/adapter-cloudflare`; `wrangler.jsonc` defines the
`staging` and `prod` environments (custom domains `cairn-staging.example.net` /
`cairn.example.net` — replace with the real domains before deploying).

```bash
pnpm --filter @cairn/adapter-cloudflare deploy:staging   # wrangler deploy --env staging
pnpm --filter @cairn/adapter-cloudflare deploy:prod
```

After deploying:

1. **Port 80 for `/v1/captive`** (docs/07): keep "Always Use HTTPS" off for the
   hostname or exempt the path, then verify:
   `curl -i -H 'Switchback-Challenge: abcdefgh12345678' http://<host>/v1/captive`
   → `204` + `Switchback-Response`.
2. **Smoke**: `cargo run -p e2e -- --cairn wss://<host> --scenario smoke`.
3. **Doc 04 risks 1–4** (CPU accumulation, subrequest limits, ping handling, DO wake
   latency): measure with `tools/load` and record numbers in `docs/decisions.md`.

**Status: deployment and risk measurements are blocked on Cloudflare account
credentials** (API token + zone). Everything short of deploy is verified locally:
router/unit semantics under Miniflare, and the full host conformance suite (13/13) plus
e2e `probes`, `echo-relayed`, `displace`, `gone`, `replay`, `stale` against
`wrangler dev` (real workerd) via `scripts/test-cf-host.sh`.

Secrets at deploy time: set `ACCESS_TOKEN_PUBLIC_KEYS` (doc 10, M8) with
`wrangler secret put --env <env>`.
