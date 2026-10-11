// Host conformance runs against a live `wrangler dev` (node pool, not the workers pool,
// so WRANGLER_DEV_URL is visible). Usage: WRANGLER_DEV_URL=ws://127.0.0.1:8787
// pnpm --filter @cairn/adapter-cloudflare exec vitest run --config vitest.host.config.ts test/host.spec.ts
export default {
  test: {
    include: ["test/host.spec.ts"],
    testTimeout: 30_000,
  },
};
