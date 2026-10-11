# 11 — Milestones

Work in order. A milestone is done when every acceptance check passes in CI and its docs are
current. Record measurements and decisions in `docs/decisions.md` as you go.

## M0 — Scaffold

Deliverables
- Repo layout from `AGENTS.md` (incl. `clients/<language>/` SDK layout, ADR-011); pnpm
  workspace with empty packages; Cargo workspace covering `clients/rust/*` and `tools/*`.
- mise-pinned toolchains (Node, pnpm, Rust) in `.mise.toml`; `rust-toolchain.toml`.
- Stub crates/packages that build and pass trivial tests.
- Biome, Vitest, TypeScript project references; `.github/workflows/ci.yml`.

Acceptance
- [ ] `pnpm -r build`, `pnpm -r test`, `pnpm lint`, `cargo test --workspace` all pass.
- [ ] CI green on a PR.

## M1 — Protocol codec, auth and vectors (TS + Rust)

Deliverables
- `packages/core`: `keys`, `crypto`, `auth`, `frames` (+ `forwardTransform`), `http`, `upgrade`.
- `clients/rust/switchback-proto`: Rust codec + auth blob creation/verification.
- `tools/vectors`: generates the JSON vectors of doc 08 §1.

Acceptance
- [ ] TS and Rust both pass every vector, both directions.
- [ ] BLAKE3 parity tests (value in `CLAUDE.md`, plus our upgrade-auth context).
- [ ] Strict Ed25519: small-order keys and non-canonical S rejected on both sides.
- [ ] `negotiateUpgrade` returns the exact statuses/bodies of doc 01 §3.1 for each failure.

## M2 — Core state machine, registry, memory router

Deliverables
- `core/connection.ts`, `core/registry.ts`, `core/limits.ts`, `core/config.ts`.
- `packages/router-memory` (incl. `NonceCache`).
- `packages/conformance/router.spec.ts` running against the memory router.

Acceptance
- [ ] Property tests for registry and connection SM (doc 02) with ≥ 10 000 runs.
- [ ] Router conformance: all nine semantics pass for memory.

## M3 — Node adapter, single instance

Deliverables
- `packages/adapter-node` with memory router, offload TLS mode, admin port, graceful drain.
- TypeScript protocol test client in `packages/conformance`; `host.spec.ts`.
- `pnpm --filter @cairn/adapter-node dev`.

Acceptance
- [ ] Host conformance passes against a local Node relay.
- [ ] `curl` checks for `/v1/ping`, `/v1/captive` (challenge echo), `/healthz`.
- [ ] 10 000 concurrent idle test connections on one local process without errors (record RSS/CPU).

## M4 — Client: first end-to-end

Deliverables
- Client work items **C1** (Switchback v1 relay client), **C2** (WebSocket keepalive), **C6**
  (Cairn probes) and **C7** (no foreign network defaults).
- QUIC protocol library choice recorded as an ADR (doc 09).
- `clients/rust/switchback-endpoint` 1.0.0-alpha with `SwitchbackConfig`, `builder`, `addr`,
  `CairnLookup`, `builder_relay_only`.
- `tools/e2e` scenarios: `echo-relayed`, `displace`, `gone`, `replay`, `stale`, `probes`, `smoke`.

Acceptance
- [ ] All listed e2e scenarios pass against local Node in CI.
- [ ] Only Switchback v1 frames on the wire (assert with a frame-recording proxy in the test); a client offering any other subprotocol gets `400`.

## M5 — Cloudflare

Deliverables
- `packages/adapter-cloudflare`: Worker, Mailbox DO, link cache, Miniflare `Router` harness.
- `deploy/cloudflare` with staging + prod environments; port-80 `/v1/captive` working.

Acceptance
- [ ] Router and host conformance pass under Miniflare.
- [ ] E2E `smoke`, `echo-relayed`, `displace`, `gone`, `replay` pass against staging.
- [ ] Doc 04 risks 1–4 measured and written up in `docs/decisions.md` with numbers.

## M6 — Container pools on AWS, GCP, Azure

> **Status: partially complete (recorded 2026-10-11, ADR-017).** Everything buildable and
> verifiable locally is done and green: `router-redis` (Lua + 10k-op differential tests),
> router conformance on Redis standalone and cluster, multi-instance adapter support,
> the 2-instance + Redis host/kill-a-host acceptance checks, the multi-arch container
> image, and `tofu validate`-clean Terraform for all three providers. **Provider staging
> deploys are not done** — no AWS/GCP/Azure credentials are available in this
> environment. The docker-compose pool (`deploy/docker`) is the deployable proof
> (e2e `smoke` on node 1, all scenarios on node 2). Remaining when credentials exist:
> push the image to each provider's registry, `terraform apply`, run
> `cargo run -p e2e -- --cairn <url> --scenario smoke` per provider, verify Container
> Apps ingress timeouts (open question, ADR-017).

Deliverables
- `packages/router-redis` (Lua, pub/sub, liveness, nonce claims) + differential tests.
- Multi-instance support in `adapter-node` (registering-window buffering, local fast path).
- `deploy/docker` multi-arch image; Terraform for AWS (ECS+NLB+ElastiCache), GCP (Cloud Run+LB+Memorystore),
  Azure (Container Apps+Managed Redis). One provider at a time, staging only.

Acceptance
- [ ] Router conformance passes on Redis standalone and cluster.
- [ ] Host conformance passes with 2 local instances + Redis, with peers on different instances.
- [ ] Kill-a-host test: routes to its endpoints go offline ≤ 15 s; keys expire ≤ 60 s.
- [ ] E2E `smoke` passes against each provider's staging deployment.
- [ ] Container Apps ingress timeouts verified and recorded.

## M7 — Client: cost and reliability

> **Status: complete except the environment-blocked items (2026-10-11, ADR-018).** C3
> (make-before-break), C4 (quiet relay path via the hybrid socket + in-band candidate
> exchange) and C5 (STUN) are implemented; e2e `echo-direct`, `restart`, `max-age` and
> `stun` pass in CI. Deferred for lack of a NAT lab / GCP deployment: NAT-simulation
> direct-path success numbers and Cloud Run hourly-recycling verification.

Deliverables
- Client work items **C3** (make-before-break), **C4** (quiet relay path), **C5** (STUN address
  discovery).
- E2E scenarios `echo-direct`, `restart`, `max-age`, `stun`; nightly NAT-simulation job.

Acceptance
- [ ] `echo-direct`: relay frames for the connection reach zero within 35 s of going direct.
- [ ] `restart` and `max-age`: zero application message loss on a reliable stream.
- [ ] STUN direct-path success rate ≥ the QAD baseline in the NAT simulation (record both numbers).
- [ ] Cloud Run staging: hourly connection recycling invisible to the e2e soak test.

## M8 — Hardening and production

Deliverables
- Access tokens (`core/tokens.ts`, dev token CLI), all abuse limits of doc 10, metrics and
  dashboards, runbooks exercised once each on staging.
- `tools/load` runs per platform; cost model CSV; autoscaling targets set from measurements.
- Production deploy on Cloudflare (and any hyperscaler that is needed).

Acceptance
- [ ] Load test: 100 000 idle connections + 5 000 new peer connections/minute on staging Cloudflare
      without errors; record DO requests per connection-hour and per new peer connection.
- [ ] Equivalent load on one container platform; record instances needed and Redis load.
- [ ] Security review checklist (doc 10 threat model) signed off in `docs/decisions.md`.
