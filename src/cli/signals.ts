/**
 * Presence signals: what says "someone was doing something", never "this is
 * work". Read-only and stateless - nothing here is stored, and no measure ever
 * sees it. The one consumer is the popup nudge.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DotPresence {
  available: boolean;
  last_activity_at: number | null;
}

/** Dot is the app's cloud side: it leaves no local intervals, only this stamp. */
export function defaultDotStatePath(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), ".codex-global-state.json");
}

/** The file mixes epoch milliseconds and seconds; anything else is ignored. */
function toMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const ms = Math.round(value > 1e12 ? value : value * 1000);
  return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
}

/** A bare number, or a wrapper object carrying a timestamp field. */
function activityAt(value: unknown): number | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ["at", "timestamp", "updated_at", "updatedAt"]) {
      const ms = toMs(record[key]);
      if (ms !== null) return ms;
    }
    return null;
  }
  return toMs(value);
}

/** Latest Dot activity across the app's profiles; unavailable is null, never zero. */
export function readDotPresence(statePath: string = defaultDotStatePath()): DotPresence {
  try {
    const file = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    const atoms = file["electron-persisted-atom-state"];
    if (!atoms || typeof atoms !== "object" || Array.isArray(atoms)) return { available: false, last_activity_at: null };
    let latest: number | null = null;
    for (const [key, value] of Object.entries(atoms as Record<string, unknown>)) {
      if (!key.startsWith("aeon-last-activity-v1:")) continue;
      const ms = activityAt(value);
      if (ms !== null && (latest === null || ms > latest)) latest = ms;
    }
    return latest === null ? { available: false, last_activity_at: null } : { available: true, last_activity_at: latest };
  } catch {
    return { available: false, last_activity_at: null };
  }
}
