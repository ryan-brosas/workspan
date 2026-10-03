/**
 * Local Codex adapter: turn timing only.
 *
 * It reads the installed Codex history database read-only and turns each turn's
 * timing into agent-runtime evidence. It deliberately does not:
 *   - select item bodies, prompts, replies, tool arguments or error payloads
 *   - claim a human origin (Codex's `User` origin is explicitly unclassified, so
 *     a turn is agent runtime, which is not proof of attendance)
 *   - attribute a project from a cwd or an application name
 *
 * Replay is safe: event identity is derived from the Codex turn id, so running
 * the importer twice adds nothing.
 */
import { readdirSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EvidenceEvent } from "../daemon/evidence.ts";

export interface CodexTurn { threadId: string; turnId: string; startedAtMs: number | null; completedAtMs: number | null }

/** What the query saw. These are properties of the source, not of the evidence. */
export interface CodexReadSummary {
  /** Turns returned inside the requested window. */
  turns: number;
  /** A completion older than its start is dropped rather than counted backwards. */
  anomalies: number;
  /** Turns with an end but no start: no duration can be claimed. */
  endsWithoutStart: number;
  /** The store that answered, or null when no thread history exists at all. */
  store: string | null;
  /** Store file mtime, for "the file moved but the data did not". */
  storeMtime: number | null;
  /** Latest turn ever recorded in the store, not just inside the window. */
  lastTurnAt: number | null;
  /** Whole days since that latest turn; "stale, not empty" in one number. */
  staleDays: number | null;
}

/** What the importer would deliver. Bounds cover the emitted evidence only. */
export interface CodexCollectSummary extends CodexReadSummary {
  events: number;
  from: number | null;
  to: number | null;
}

export interface CodexCollectOptions { dbPath?: string; sinceMs?: number; limit?: number; instance?: string; now?: number }

/** `$CODEX_HOME` honours a non-default install, as the shell's agents widget does. */
export function defaultCodexHistoryPath(): string {
  return join(codexHomeDir(), "thread_history_1.sqlite");
}

/** Where the app keeps its state; `$CODEX_HOME` honours a non-default install. */
function codexHomeDir(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

function mtimeOf(path: string): number | null {
  try { const value = statSync(path).mtimeMs; return Number.isFinite(value) ? Math.round(value) : null; } catch { return null; }
}

/** A store this shape is a thread history; anything else is not a source. */
function hasThreadTurns(path: string): boolean {
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    try { return db.prepare("select 1 from sqlite_master where type = 'table' and name = 'thread_turns'").get() !== undefined; }
    finally { db.close(); }
  } catch { return false; }
}

/**
 * The store is a versioned observation, not a fixed path: the app names them
 * `thread_history_<n>.sqlite`, so the newest one that still carries
 * `thread_turns` answers. None at all is "unavailable", never zero usage.
 */
export function discoverCodexHistoryPath(home: string = codexHomeDir()): string | null {
  let names: string[];
  try { names = readdirSync(home); } catch { return null; }
  const candidates = names
    .filter(name => /^thread_history_\d+\.sqlite$/.test(name))
    .map(name => ({ path: join(home, name), mtime: mtimeOf(join(home, name)) }))
    .filter(candidate => candidate.mtime !== null)
    .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
  for (const candidate of candidates) if (hasThreadTurns(candidate.path)) return candidate.path;
  return null;
}

/** Timing columns only. The select list is the privacy boundary and is tested as such. */
export const TURN_QUERY = `
select thread_id, turn_id, started_at, completed_at
from thread_turns
where coalesce(started_at, completed_at) >= ?
order by coalesce(started_at, completed_at) asc, thread_id asc, turn_id asc
limit ?
`;

const toMs = (seconds: unknown): number | null => {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return null;
  const ms = Math.round(value * 1000);
  return Number.isSafeInteger(ms) && ms >= 0 ? ms : null;
};

/** Read turn timing inside a window. Stored columns are epoch seconds; output is milliseconds. */
export function readCodexTurns(options: CodexCollectOptions = {}): { turns: CodexTurn[]; summary: CodexReadSummary } {
  const dbPath = options.dbPath ?? discoverCodexHistoryPath();
  const sinceMs = options.sinceMs ?? Date.now() - 86_400_000;
  const limit = Math.min(Math.max(1, options.limit ?? 5000), 50_000);
  if (dbPath === null) {
    // No store is not "no usage": it is a capability that cannot answer, and the
    // summary says so instead of pretending a zero.
    return { turns: [], summary: { turns: 0, anomalies: 0, endsWithoutStart: 0, store: null, storeMtime: null, lastTurnAt: null, staleDays: null } };
  }
  const storeMtime = mtimeOf(dbPath);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(TURN_QUERY).all(Math.floor(sinceMs / 1000), limit) as Array<Record<string, unknown>>;
    const turns: CodexTurn[] = [];
    let anomalies = 0, endsWithoutStart = 0;
    for (const row of rows) {
      const startedAtMs = toMs(row.started_at);
      let completedAtMs = toMs(row.completed_at);
      if (startedAtMs === null && completedAtMs === null) continue;
      if (startedAtMs !== null && completedAtMs !== null && completedAtMs < startedAtMs) { anomalies++; completedAtMs = null; }
      if (startedAtMs === null) endsWithoutStart++;
      turns.push({ threadId: String(row.thread_id), turnId: String(row.turn_id), startedAtMs, completedAtMs });
    }
    // The latest moment the store knows about: the end when there is one, the
    // start otherwise. A turn that closed a minute ago is fresh even if it began
    // hours earlier.
    const latest = db.prepare("select max(started_at) as started, max(completed_at) as completed from thread_turns").get() as { started?: unknown; completed?: unknown } | undefined;
    const started = toMs(latest?.started);
    const completed = toMs(latest?.completed);
    const lastTurnAt = started === null ? completed : completed === null ? started : Math.max(started, completed);
    const now = options.now ?? Date.now();
    const staleDays = lastTurnAt === null ? null : Math.max(0, Math.floor((now - lastTurnAt) / 86_400_000));
    return { turns, summary: { turns: turns.length, anomalies, endsWithoutStart, store: dbPath, storeMtime, lastTurnAt, staleDays } };
  } finally { db.close(); }
}

/** One start and/or end per turn. An end without a start contributes nothing. */
export function toEvidence(turns: readonly CodexTurn[], instance = "local"): EvidenceEvent[] {
  const events: EvidenceEvent[] = [];
  for (const turn of turns) {
    if (turn.startedAtMs !== null) {
      events.push({ source: "codex", instance, session: turn.threadId, event: `${turn.turnId}:start`, kind: "agent-start", at: turn.startedAtMs, origin: "automated" });
    }
    if (turn.startedAtMs !== null && turn.completedAtMs !== null) {
      events.push({ source: "codex", instance, session: turn.threadId, event: `${turn.turnId}:end`, kind: "agent-end", at: turn.completedAtMs, origin: "automated" });
    }
  }
  return events;
}

export function collectCodexEvents(options: CodexCollectOptions = {}): { events: EvidenceEvent[]; summary: CodexCollectSummary } {
  const { turns, summary } = readCodexTurns(options);
  const events = toEvidence(turns, options.instance ?? "local");
  const from = events.reduce<number | null>((min, e) => (min === null || e.at < min ? e.at : min), null);
  const to = events.reduce<number | null>((max, e) => (max === null || e.at > max ? e.at : max), null);
  return { events, summary: { ...summary, events: events.length, from, to } };
}
