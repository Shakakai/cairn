/**
 * Instance id derivation (doc 05): ECS task metadata, Cloud Run revision, Container Apps
 * replica name, else the hostname. Best-effort and never fatal.
 */

import { randomBytes } from "node:crypto";
import { hostname } from "node:os";

export async function platformInstanceId(): Promise<string> {
  const ecs = process.env.ECS_CONTAINER_METADATA_URI_V4;
  if (ecs !== undefined) {
    try {
      const res = await fetch(ecs, { signal: AbortSignal.timeout(2_000) });
      const meta = (await res.json()) as { TaskARN?: string };
      if (meta.TaskARN !== undefined) {
        return meta.TaskARN.split("/").at(-1) ?? meta.TaskARN;
      }
    } catch {
      // fall through to hostname
    }
  }
  const revision = process.env.K_REVISION;
  if (revision !== undefined) return `${revision}-${hostname()}`;
  const replica = process.env.CONTAINER_APP_REPLICA_NAME;
  if (replica !== undefined) return replica;
  return hostname();
}

/** Stable per-process id: platform id + random suffix (doc 05). */
export async function instanceId(): Promise<string> {
  const platform = await platformInstanceId();
  return `${platform}-${randomBytes(3).toString("hex")}`;
}
