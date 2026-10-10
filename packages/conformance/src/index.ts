/**
 * Shared conformance suites every Router and SocketHost implementation must pass
 * (docs/03, 08 §3). Parameterised over implementations: memory (M2), Redis (M6),
 * Cloudflare mailbox (M5).
 */

export * from "./recordingHost.js";
export * from "./routerSuite.js";
