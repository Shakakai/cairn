# 07 — Deployment

Every deployment exposes one hostname (`cairn.<domain>` or a per-environment variant) with HTTPS on
443 and plain HTTP on 80 for `/v1/captive`. Address discovery uses Cloudflare's public STUN
(`stun.cloudflare.com:3478`) for every deployment, so no deployment runs UDP services.

Environments: `dev` (local), `staging`, `prod`. One Terraform workspace per provider × environment.

## Shared requirements (all providers)

| Requirement | Why |
| --- | --- |
| HTTPS 443 → relay, WebSockets allowed, no request-body buffering | the relay socket |
| HTTP 80 → relay for `/v1/captive` with **no redirect** | client captive-portal check (doc 01 §2.1) |
| Idle timeout on any proxy ≥ 60 s | client pings every 15 s |
| Health check on `/readyz` (or `/healthz?ready=1` on the serving port) | drain-aware routing |
| Config via `RELAY_CONFIG` (JSON) or `RELAY_CONFIG_FILE`, secrets via the platform's secret store | doc 10 |
| Logs to stdout as JSON; metrics via Prometheus `/metrics` (Node) or Analytics Engine (Cloudflare) | doc 10 |

## Cloudflare (`deploy/cloudflare`)

- `wrangler deploy` from `packages/adapter-cloudflare` with `wrangler.jsonc` (doc 04). Use
  `--env staging|prod` sections with different custom domains.
- **Custom domain** `cairn.<domain>` on a zone in the account.
- **Port 80:** ensure `http://cairn.<domain>/v1/captive` reaches the Worker without a redirect.
  Either keep the zone's "Always Use HTTPS" off for this hostname or add a rule that exempts this
  path. Verify with `curl -i -H 'Switchback-Challenge: abcdefgh12345678' http://cairn.<domain>/v1/captive`
  → `204` + `Switchback-Response`.
- Workers Paid plan (Durable Objects with SQLite storage, `cpu_ms` up to 300 000).
- Terraform (optional): manage the zone records, Workers custom domain and secrets with the
  Cloudflare provider; deploy code with wrangler in CI.

## Container image (`deploy/docker`)

One image for every hyperscaler: `adapter-node`, multi-arch (amd64/arm64), non-root, `tini`.
Published to each provider's registry (ECR, Artifact Registry, ACR) by CI.

Environment for all container deployments:

| Var | Example |
| --- | --- |
| `PORT` | `8080` |
| `RELAY_CONFIG` | `{"router":{"kind":"redis","url":"rediss://..."},"region":"us-east-1"}` |
| `ACCESS_TOKEN_PUBLIC_KEYS` | from the secret store |
| `INSTANCE_ID` | optional; auto-derived otherwise (doc 05) |

## AWS (`deploy/aws`)

| Piece | Choice |
| --- | --- |
| Compute | ECS on Fargate, ARM64 (Graviton), ≥ 2 tasks across ≥ 2 AZs |
| Load balancer | Network Load Balancer: TLS listener :443 (ACM cert) → target 8080; TCP listener :80 → 8080 |
| Health check | HTTP `/healthz?ready=1` on 8080 (or `/readyz` on 9090 if exposed to the target group) |
| Router | ElastiCache for Valkey (cluster mode disabled to start; Multi-AZ replica) |
| Secrets | Secrets Manager → task env |
| DNS | Route 53 alias `cairn.<domain>` → NLB |
| Scaling | Target tracking on a custom CloudWatch metric `relay_connections` per task (target set from M7 load tests) plus CPU 60% |
| Shutdown | `stopTimeout` 60 s; `drainWindowMs` 45 s |
| Deregistration delay | 60 s on the target group |

Terraform modules: `network` (VPC, subnets), `cache`, `service` (task def, service, autoscaling),
`lb`, `dns`.

## GCP (`deploy/gcp`)

| Piece | Choice |
| --- | --- |
| Compute | Cloud Run service; request timeout 3600 s; concurrency 1000; CPU always allocated; min instances ≥ 1; session affinity on |
| Router | Memorystore for Valkey (or Redis), reached via Direct VPC egress |
| Entry | Global external Application Load Balancer with a serverless NEG; HTTPS :443 with a Google-managed cert; HTTP :80 forwarding to the same backend **without** an HTTPS redirect |
| Health | Cloud Run startup/liveness probes on `/healthz?ready=1` |
| Secrets | Secret Manager mounted as env |
| Connection limit | Requests end after 3600 s → set `RELAY_CONFIG.caps.maxConnectionMs = 3600000` so the core sends `Restarting` before the cut |
| Shutdown | SIGTERM grace is 10 s → `drainWindowMs` 8 s |

Note: Cloud Run bills an instance while any WebSocket is open; idle clients cost instance time.
Size instances for ~1 000 sockets each and validate in M7.

## Azure (`deploy/azure`)

| Piece | Choice |
| --- | --- |
| Compute | Azure Container Apps (workload profile environment, VNet-integrated), min replicas ≥ 2 |
| Ingress | External, target port 8080, transport HTTP/1.1, `allowInsecure: true` so port 80 serves `/v1/captive` |
| Router | Azure Managed Redis (or Azure Cache for Redis) via private endpoint |
| Domain | Custom domain + managed certificate on the Container Apps environment |
| Health | Readiness probe `/healthz?ready=1` |
| Secrets | Container Apps secrets / Key Vault references |
| Scaling | KEDA rule on a custom metric or CPU; validate in M7 |

Verify in M6 and record in `docs/decisions.md`: ingress idle timeout and any maximum request
duration for WebSockets on Container Apps; set `maxConnectionMs` if there is one.

## Multi-region (later; doc 12)

Single region per hyperscaler first. Cloudflare is global from day one.

## CI/CD (`.github/workflows`)

- `ci.yml`: install, build, lint, unit + integration tests (Testcontainers Valkey), Miniflare tests,
  `cargo test`, vector parity check.
- `deploy-cloudflare.yml`: on tag → `wrangler deploy --env staging`, run e2e smoke against staging,
  manual approval → prod.
- `deploy-containers.yml`: build/push image → `terraform apply` per provider/env → e2e smoke.
- Smoke test = `cargo run -p e2e -- --cairn https://<env host> --scenario smoke`.
