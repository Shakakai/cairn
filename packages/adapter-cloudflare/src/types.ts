/**
 * Environment bindings for the Cairn Edge Worker (docs/04, 07).
 */

export interface Env {
  /** One Mailbox Durable Object per EndpointId. */
  MAILBOX: DurableObjectNamespace;
  /** Analytics Engine dataset for the doc 10 metrics (optional in dev/tests). */
  METRICS?: AnalyticsEngineDataset;
  /** JSON RelayConfig (docs/10); "{}" by default. */
  RELAY_CONFIG: string;
  /** VCS commit for /healthz (injected by CI; "dev" otherwise). */
  GIT_COMMIT?: string;
  /** JSON map kid -> base64 Ed25519 public key for access tokens (doc 10). */
  ACCESS_TOKEN_PUBLIC_KEYS?: string;
}
