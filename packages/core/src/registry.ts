/**
 * Per-EndpointId registry reducer (docs/01 §5, docs/02): one active connection per endpoint
 * (newest wins), an inactive stack, promotion on close, PeerGone on full departure, and the
 * connection-count cap. Every Router implements exactly these rules — the Redis router
 * reimplements them in Lua and is differential-tested against this function (doc 06).
 *
 * Pure: entry in, entry + outputs out.
 */

import type { EndpointId } from "./keys.js";
import { type ConnRef, connKey, type Notice } from "./ports.js";

export const DEFAULT_MAX_CONNECTIONS_PER_ENDPOINT = 4;
export const DEFAULT_SENT_TO_MAX = 4096;

export interface EndpointEntry {
  active?: ConnRef;
  /** Stack; most recently deactivated last (promotion pops from the end). */
  inactive: ConnRef[];
  /** Union of sent-to sets reported by closing connections, insertion-ordered, bounded. */
  sentTo: EndpointId[];
}

export type RegistryOp =
  | { op: "register"; conn: ConnRef }
  | { op: "unregister"; conn: ConnRef; sentTo: EndpointId[] };

export type RegistryOut =
  | { notify: ConnRef; notice: Notice }
  | { close: ConnRef; code: 1008 }
  | { gone: { endpoint: EndpointId; notifyEndpoints: EndpointId[] } }
  | { deleteEntry: true };

export interface RegistryResult {
  entry: EndpointEntry | undefined;
  out: RegistryOut[];
}

export interface RegistryOptions {
  /** maxConnectionsPerEndpoint (doc 10). Default 4. */
  maxConnections?: number;
  /** Bound of the merged sent-to union (doc 10). Default 4096. */
  sentToMax?: number;
}

/**
 * Apply one op to one endpoint's entry. `entry` may be undefined (first sight of the
 * endpoint); a fully departed endpoint returns `entry: undefined`.
 */
export function registryStep(
  endpoint: EndpointId,
  entry: EndpointEntry | undefined,
  op: RegistryOp,
  options: RegistryOptions = {},
): RegistryResult {
  const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS_PER_ENDPOINT;
  const sentToMax = options.sentToMax ?? DEFAULT_SENT_TO_MAX;

  switch (op.op) {
    case "register": {
      // Re-registering the currently active connection is a no-op (adapters register each
      // connection exactly once; a duplicate register must not duplicate the connection).
      if (entry?.active !== undefined && connKey(entry.active) === connKey(op.conn)) {
        return { entry, out: [] };
      }
      const out: RegistryOut[] = [];
      // A connection re-registered from the inactive stack moves up: drop it from inactive.
      const inactive = (entry?.inactive ?? []).filter((c) => connKey(c) !== connKey(op.conn));
      const active = entry?.active;
      if (active !== undefined) {
        inactive.push(active);
        out.push({ notify: active, notice: "becameInactive" });
      }
      out.push({ notify: op.conn, notice: "becameActive" });
      // Cap: active + inactive must not exceed maxConnections; evict oldest inactive with 1008.
      while (1 + inactive.length > maxConnections) {
        const evicted = inactive.shift();
        if (evicted === undefined) break;
        out.push({ close: evicted, code: 1008 });
      }
      return {
        entry: { active: op.conn, inactive, sentTo: entry?.sentTo ?? [] },
        out,
      };
    }

    case "unregister": {
      if (entry === undefined) return { entry: undefined, out: [] };
      const out: RegistryOut[] = [];
      const sentTo = mergeBounded(entry.sentTo, op.sentTo, sentToMax);
      const active = entry.active;
      const connIsActive = active !== undefined && connKey(active) === connKey(op.conn);

      if (connIsActive) {
        const inactive = [...entry.inactive];
        if (inactive.length > 0) {
          const promoted = inactive.pop() as ConnRef;
          out.push({ notify: promoted, notice: "promoted" });
          return { entry: { active: promoted, inactive, sentTo }, out };
        }
        // Fully gone: notify the sent-to union once, then delete the entry.
        out.push({ gone: { endpoint, notifyEndpoints: [...sentTo] } });
        out.push({ deleteEntry: true });
        return { entry: undefined, out };
      }

      const index = entry.inactive.findIndex((c) => connKey(c) === connKey(op.conn));
      if (index < 0) {
        // Unknown connection: no-op.
        return { entry: { ...entry, sentTo }, out };
      }
      const inactive = [...entry.inactive];
      inactive.splice(index, 1);
      return {
        entry: { ...(entry.active !== undefined ? { active: entry.active } : {}), inactive, sentTo },
        out,
      };
    }
  }
}

/** Union of existing + reported sent-to sets, bounded to the newest `max` entries. */
function mergeBounded(existing: EndpointId[], reported: EndpointId[], max: number): EndpointId[] {
  const seen = new Set<EndpointId>();
  const merged: EndpointId[] = [];
  // Newest-wins ordering: reported first (they just closed), then existing.
  for (const id of [...reported, ...existing]) {
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(id);
  }
  return merged.slice(0, max);
}
