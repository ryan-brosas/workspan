/**
 * The harness-reader contract: one shape for every local agent history we can
 * read without touching the harness itself. A reader discovers its store, proves
 * it is still the shape it understands, and turns timing only into evidence.
 * A missing store is reported as unavailable, never as zero activity.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { repositoryRoot } from "../core/workspace.ts";
import type { EvidenceEvent, Source } from "../daemon/evidence.ts";

/** Activity inside this silence is one unit; a longer gap starts the next one. */
export const SETTLE_GAP_MS = 5 * 60_000;

export interface HarnessProbe {
  store: string | null;
  storeMtime: number | null;
  /** Latest moment the store knows about, inside the window or not. */
  lastEventAt: number | null;
  /** Whole days since that moment: "stale, not empty" in one number. */
  staleDays: number | null;
}

export interface HarnessSummary extends HarnessProbe {
  events: number;
  from: number | null;
  to: number | null;
  [extra: string]: unknown;
}

export interface HarnessReadOptions {
  sinceMs?: number;
  now?: number;
  limit?: number;
  instance?: string;
  /** Explicit store path, for tests and non-default installs. */
  store?: string;
}

export interface HarnessReader {
  id: string;
  source: Source;
  /** Cheap availability and freshness: discovery plus one indexed query. */
  probe(options?: { now?: number; store?: string }): HarnessProbe;
  read(options?: HarnessReadOptions): { events: EvidenceEvent[]; summary: HarnessSummary };
}

export function mtimeOf(path: string): number | null {
  try { const value = statSync(path).mtimeMs; return Number.isFinite(value) ? Math.round(value) : null; } catch { return null; }
}

/** Newest file matching `pattern` that `usable` accepts: the store is versioned, not fixed. */
export function newestStore(dir: string, pattern: RegExp, usable: (path: string) => boolean): string | null {
  let names: string[];
  try { names = readdirSync(dir); } catch { return null; }
  const candidates = names
    .filter(name => pattern.test(name))
    .map(name => ({ path: join(dir, name), mtime: mtimeOf(join(dir, name)) }))
    .filter(candidate => candidate.mtime !== null)
    .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
  for (const candidate of candidates) if (usable(candidate.path)) return candidate.path;
  return null;
}

export function staleDaysOf(now: number, lastEventAt: number | null): number | null {
  if (lastEventAt === null) return null;
  return Math.max(0, Math.floor((now - lastEventAt) / 86_400_000));
}

export function unavailable(): HarnessProbe {
  return { store: null, storeMtime: null, lastEventAt: null, staleDays: null };
}

export function emptySummary(): HarnessSummary {
  return { ...unavailable(), events: 0, from: null, to: null };
}

/** Epoch milliseconds in, epoch milliseconds out; anything unusable is null. */
export function toMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const ms = Math.round(value);
  return Number.isSafeInteger(ms) ? ms : null;
}

/** The workspace a directory belongs to, or undefined when nothing binds it. */
export function rootOfDirectory(directory: unknown): string | undefined {
  if (typeof directory !== "string" || !directory.startsWith("/") || directory === "/") return undefined;
  if (/^(\/proc|\/sys|\/dev|\/run)(\/|$)/.test(directory)) return undefined;
  return repositoryRoot(directory);
}
