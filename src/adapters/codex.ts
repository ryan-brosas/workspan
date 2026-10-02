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
}

/** What the importer would deliver. Bounds cover the emitted evidence only. */
export interface CodexCollectSummary extends CodexReadSummary {
  events: number;
  from: number | null;
  to: number | null;
}

export interface CodexCollectOptions { dbPath?: string; sinceMs?: number; limit?: number; instance?: string }

/** `$CODEX_HOME` honours a non-default install, as the shell's agents widget does. */
export function defaultCodexHistoryPath(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "thread_history_1.sqlite");
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
  const dbPath = options.dbPath ?? defaultCodexHistoryPath();
  const sinceMs = options.sinceMs ?? Date.now() - 86_400_000;
  const limit = Math.min(Math.max(1, options.limit ?? 5000), 50_000);
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
    return { turns, summary: { turns: turns.length, anomalies, endsWithoutStart } };
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
