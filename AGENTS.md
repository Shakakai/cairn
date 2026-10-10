# AGENTS.md — Switchback + Cairn

You are building a new peer-to-peer network stack:

- **Switchback** — the protocol and client stack. Endpoints are identified by Ed25519 keys, meet
  through a relay, holepunch a direct UDP path, and fall back to the relay when they can't.
  Traffic starts on the relay and *switches back* to a direct route.
- **Cairn** — the relay and discovery infrastructure endpoints meet at. One Cairn deployment is one
  hostname, e.g. `cairn.example.net`. Each online endpoint has a *mailbox* in Cairn that marks
  where it can be reached.

**Switchback v1 is the first version of this system.** There are no earlier clients, protocols or
relays to support, and no compatibility with any other network (including any other production
peer-to-peer network). The relay accepts `switchback.v1` only. Do not write fallback, downgrade
or legacy code paths.

The client is a **complete from-scratch implementation** (Rust, doc 09). Prior peer-to-peer
QUIC relay stacks informed the design, but no third-party P2P stack is imported into this
repository: there is no fork, no submodule and no dependency on any foreign network's code,
and no foreign network is ever mentioned in specs, code or commit messages. Reference source,
when needed for ideas, lives **outside** the repository (e.g. a scratch clone in `/tmp`).

## Parts

1. **Cairn server** (TypeScript): a pure core library plus adapters for **Cloudflare Workers +
   Durable Objects** (first target) and a **Node container** for AWS ECS/Fargate, GCP Cloud Run,
   Azure Container Apps or any VM, with Redis/Valkey for multi-instance routing.
2. **Switchback protocol v1** (doc 01): authenticated WebSocket upgrade, eight binary frame types,
   WebSocket-level keepalives.
3. **Switchback client SDKs**: the reference implementation is Rust, published as
   `switchback-endpoint 1.0.0` — the first client release, speaking `switchback.v1`. The
   repository layout reserves room for SDKs in other languages (`clients/rust/`, future
   `clients/typescript/`, `clients/python/`, …).

## Read these before writing code

| Doc | What it gives you |
| --- | --- |
| `docs/00-overview.md` | Goals, non-goals, architecture, names, glossary |
| `docs/01-protocol.md` | **Normative wire spec, Switchback v1** (server and client both follow it) |
| `docs/02-core.md` | The pure TypeScript core: types, state machine, registry rules |
| `docs/03-ports.md` | `SocketHost` and `Router` contracts every server adapter implements |
| `docs/04-adapter-cloudflare.md` | Cairn on Cloudflare: Worker + Mailbox Durable Object |
| `docs/05-adapter-node.md` | Cairn as a Node container |
| `docs/06-router-redis.md` | Multi-instance presence + delivery over Redis/Valkey |
| `docs/07-deployment.md` | Cloudflare, AWS, GCP, Azure infrastructure |
| `docs/08-testing.md` | Test layers, shared vectors, e2e with the Switchback client |
| `docs/09-client.md` | The Switchback client: crates, QUIC socket layer, app API |
| `docs/10-security-and-ops.md` | Auth tokens, abuse limits, config table, metrics, runbooks |
| `docs/11-milestones.md` | **Build order with acceptance criteria. Work milestone by milestone.** |
| `docs/12-future.md` | Deferred ideas; do not start them unprompted |
| `docs/decisions.md` | Architecture decision records; add one whenever you decide something |

`docs/` is the source of truth. Where our spec differs from any prior system, our spec wins. If
you find a better design, change the spec in the same commit and record why in `docs/decisions.md`.

## Hard rules

1. **Spec first.** Server and client both follow `docs/01-protocol.md`. A wire change updates that
   doc, the vectors and both implementations together.
2. **Only Switchback v1.** No compatibility code for any earlier or foreign protocol. Unknown
   subprotocols are rejected with `400`.
3. **The core is pure.** `packages/core` performs no I/O, reads no clock, generates no randomness
   on its own and imports nothing platform-specific (no `node:*`, no `cloudflare:*`, no Redis).
4. **Adapters are thin.** Protocol rules live in the core; adapters translate platform callbacks
   into core `Event`s and execute `Effect`s.
5. **Container pools on hyperscalers.** No adapters for managed WebSocket gateways (AWS API Gateway
   WebSockets, Azure Web PubSub, ...).
6. **Cost-aware by default.** On Cloudflare every WebSocket message into a Durable Object is
   billed. No per-message chatter (keepalives, acks, telemetry) may cross a Durable Object.
7. **Never log packet contents, auth blobs or tokens.** EndpointIds only in short form (first 10
   chars of z-base-32).
8. **Every milestone ends green**: build, tests, lint, and the acceptance checks in `docs/11-milestones.md`.
9. **Don't invent numbers silently.** New limits/timeouts become config values documented in
   `docs/10-security-and-ops.md` and noted in `docs/decisions.md`.

## Toolchain (mise-managed)

All development tools are pinned with [mise](https://mise.jdx.dev) in `.mise.toml` — Node.js
(TypeScript packages), pnpm and Rust (`rustc`/`cargo`). Run `mise install` after cloning;
`rust-toolchain.toml` matches the mise Rust pin so bare `cargo` invocations agree. Future
client SDKs in other languages pin their own toolchains the same way. The commands below assume
mise-shimmed tools (or `mise exec -- <cmd>`).

## Stack and conventions

Cairn server (TypeScript):
- TypeScript 5.x, ESM only, `strict`, `noUncheckedIndexedAccess`; pnpm workspaces; Node 24 LTS.
- Packages are published under the `@cairn/` scope (`@cairn/core`, `@cairn/adapter-node`, ...).
- Vitest; `@cloudflare/vitest-pool-workers` for Worker/DO tests; Testcontainers for Redis.
- Biome for lint + format.
- Crypto: `@noble/curves` (Ed25519) and `@noble/hashes` (BLAKE3; derive-key mode is
  `blake3(input, { context })`). Parity with Rust `blake3::derive_key` is verified for the
  connect-auth context: context `"switchback v1 connect auth"`, key material
  `utf8("cairn.example.net") || 0x00 || 56 zero bytes` →
  `31f4b855e7853ca9cd7425ce3b3651246683de3a1927a097b9e3a2a15c80509a`. Keep it as a unit test on both sides.
- `ws` for the Node WebSocket server; `ioredis` for Redis/Valkey.
- `Uint8Array` everywhere in the core; no `Buffer` there.

Switchback client SDKs (Rust):
- Crates under `clients/rust/`: `switchback-proto` (codec + auth, shared vectors),
  `switchback-stun`, `switchback-endpoint` (the app-facing crate, version 1.0.0 at first
  release). SDKs in other languages slot into `clients/<language>/` later.
- Tools in `tools/`: `vectors`, `e2e`, `load`.

Infrastructure: Terraform (OpenTofu-compatible) under `deploy/`; `wrangler` for Cloudflare.

## Repository layout (create in M0)

```
AGENTS.md
docs/
packages/                   Cairn server (TypeScript, @cairn/*)
  core/
  router-memory/
  router-redis/
  adapter-cloudflare/
  adapter-node/
  conformance/
clients/                    Switchback client SDKs (one directory per language)
  rust/
    switchback-proto/
    switchback-stun/
    switchback-endpoint/
  # future SDKs: typescript/, python/, ...
tools/                      Rust: vectors, e2e, load
deploy/
  cloudflare/ aws/ gcp/ azure/ docker/
.github/workflows/
```

## Commands (define in M0 and keep working)

Run `mise install` once after cloning (it pins Node, pnpm and Rust — see the Toolchain section
above). Then:

```
pnpm install && pnpm -r build && pnpm -r test && pnpm lint
pnpm --filter @cairn/adapter-node dev          # local Cairn on :8080
pnpm --filter @cairn/adapter-cloudflare dev    # wrangler dev on :8787
cargo test --workspace
cargo run -p vectors -- --out packages/core/test/vectors
cargo run -p e2e -- --cairn http://localhost:8080 --scenario all
cargo run -p load -- --cairn http://localhost:8080 --clients 1000
```

## How to work

- Follow `docs/11-milestones.md` in order; each milestone lists deliverables and acceptance checks.
- Small commits, one concern each, tests in the same commit.
- When behaviour is underspecified, study prior art (reference source kept outside this
  repository), decide whether to keep or improve the idea, and write the decision down.
- If a platform limit blocks a requirement, stop and document the problem and options in
  `docs/decisions.md` instead of working around it silently.
