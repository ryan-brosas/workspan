/**
 * Claude Code adapter: turn timing from local session transcripts.
 *
 * A transcript line is a JSON record; JSONL offers no column selection, so each
 * line is parsed - but only the timestamp, the record type, the session id and
 * the working directory are read. Nothing else is retained, emitted or stored.
 * A turn opens on a user record and closes on the last assistant record before
 * the next user record; the trailing turn stays visible as open until its last
 * assistant output is SETTLE_GAP_MS old. A turn that never got an answer
 * contributes nothing.
 */
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { EvidenceEvent } from "../daemon/evidence.ts";
import { SETTLE_GAP_MS, emptySummary, mtimeOf, rootOfDirectory, staleDaysOf, unavailable, type HarnessProbe, type HarnessReadOptions, type HarnessReader, type HarnessSummary } from "./harness.ts";

/** Claude Code honours `CLAUDE_CONFIG_DIR`; the default is `~/.claude`. */
export function defaultClaudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

export function claudeProjectsDir(home: string = defaultClaudeHome()): string {
  return join(home, "projects");
}

/** Transcripts newest first: `projects/<slug>/<session>.jsonl`. */
export function listClaudeTranscripts(dir: string, limit = 200): Array<{ path: string; mtime: number }> {
  const out: Array<{ path: string; mtime: number }> = [];
  let slugs: string[];
  try { slugs = readdirSync(dir); } catch { return out; }
  for (const slug of slugs) {
    let names: string[];
    try { names = readdirSync(join(dir, slug)); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, slug, name);
      const mtime = mtimeOf(path);
      if (mtime !== null) out.push({ path, mtime });
    }
  }
  // A tie on coarse filesystem timestamps is broken by path, so "the newest
  // transcript" never depends on readdir order.
  return out.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path)).slice(0, limit);
}

export function discoverClaudeStore(home: string = defaultClaudeHome()): string | null {
  const dir = claudeProjectsDir(home);
  return listClaudeTranscripts(dir, 1).length > 0 ? dir : null;
}

/** The last bounded slice of a file; a cut first line is dropped rather than guessed. */
function tailLines(path: string, maxBytes = 8_192): string[] {
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - maxBytes);
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(Math.max(1, size - start));
      readSync(fd, buffer, 0, buffer.length, start);
      const lines = buffer.toString("utf8").split("\n").filter(line => line.trim() !== "");
      return start > 0 ? lines.slice(1) : lines;
    } finally { closeSync(fd); }
  } catch { return []; }
}

/** The whole transcript, or its end when it is big: the window of interest is recent. */
function readTranscript(path: string, maxBytes = 8 * 1024 * 1024): { lines: string[]; truncated: boolean } {
  try {
    const size = statSync(path).size;
    if (size <= maxBytes) return { lines: readFileSync(path, "utf8").split("\n").filter(line => line.trim() !== ""), truncated: false };
    return { lines: tailLines(path, maxBytes), truncated: true };
  } catch { return { lines: [], truncated: false }; }
}

export interface TurnRecord { at: number; type: "user" | "assistant"; cwd: string | null; session: string | null }

function readRecords(lines: readonly string[]): TurnRecord[] {
  const out: TurnRecord[] = [];
  for (const line of lines) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (record.type !== "user" && record.type !== "assistant") continue;
    const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
    if (!Number.isFinite(at) || at <= 0) continue;
    out.push({
      at,
      type: record.type,
      cwd: typeof record.cwd === "string" && record.cwd ? record.cwd : null,
      session: typeof record.sessionId === "string" && record.sessionId ? record.sessionId : null,
    });
  }
  return out;
}

export interface ClaudeTurn { session: string; start: number; end: number | null; settled: boolean; cwd: string | null }

/** Turns from the record stream: user-anchored, assistant-closed, the last one open until settled. */
export function buildTurns(records: readonly TurnRecord[], session: string, now: number, truncated = false): ClaudeTurn[] {
  const turns: ClaudeTurn[] = [];
  let current: { start: number; lastAssistant: number | null; cwd: string | null } | null = null;
  let index = 0;
  if (truncated) { while (index < records.length && records[index].type !== "user") index++; }
  for (; index < records.length; index++) {
    const record = records[index];
    if (record.type === "user") {
      if (current && current.lastAssistant !== null) turns.push({ session, start: current.start, end: current.lastAssistant, settled: true, cwd: current.cwd });
      current = { start: record.at, lastAssistant: null, cwd: record.cwd };
      continue;
    }
    if (!current) current = { start: record.at, lastAssistant: record.at, cwd: record.cwd };
    else current.lastAssistant = record.at;
    if (record.cwd) current.cwd = record.cwd;
  }
  if (current) {
    const settled = current.lastAssistant !== null && now - current.lastAssistant >= SETTLE_GAP_MS;
    turns.push({ session, start: current.start, end: settled ? current.lastAssistant : null, settled, cwd: current.cwd });
  }
  return turns;
}

export function claudeProbe(options: { now?: number; store?: string } = {}): HarnessProbe {
  const dir = options.store ?? discoverClaudeStore();
  if (dir === null) return unavailable();
  const newest = listClaudeTranscripts(dir, 1)[0];
  if (!newest) return unavailable();
  let lastEventAt = mtimeOf(newest.path);
  for (const line of tailLines(newest.path).reverse()) {
    try {
      const value = JSON.parse(line) as { timestamp?: unknown };
      if (typeof value?.timestamp === "string") {
        const at = Date.parse(value.timestamp);
        if (Number.isFinite(at) && at > 0) { lastEventAt = at; break; }
      }
    } catch { /* a cut line is skipped, not guessed */ }
  }
  return { store: dir, storeMtime: newest.mtime, lastEventAt, staleDays: staleDaysOf(options.now ?? Date.now(), lastEventAt) };
}

export function readClaude(options: HarnessReadOptions = {}): { events: EvidenceEvent[]; summary: HarnessSummary } {
  const now = options.now ?? Date.now();
  const sinceMs = options.sinceMs ?? now - 86_400_000;
  const dir = options.store ?? discoverClaudeStore();
  const instance = options.instance ?? "local";
  if (dir === null || mtimeOf(dir) === null) return { events: [], summary: emptySummary() };

  const events: EvidenceEvent[] = [];
  let open = 0;
  let turns = 0;
  for (const file of listClaudeTranscripts(dir)) {
    if (file.mtime < sinceMs) continue;
    const { lines, truncated } = readTranscript(file.path);
    const records = readRecords(lines);
    const session = records.find(record => record.session !== null)?.session ?? basename(file.path, ".jsonl");
    for (const turn of buildTurns(records, session, now, truncated)) {
      turns++;
      const root = rootOfDirectory(turn.cwd);
      const base = { source: "claude" as const, instance, session: turn.session, ...(root ? { root } : {}) };
      events.push({ ...base, event: `turn-${turn.start}:start`, kind: "agent-start", at: turn.start, origin: "automated" });
      if (turn.end !== null) events.push({ ...base, event: `turn-${turn.start}:end`, kind: "agent-end", at: turn.end, origin: "automated" });
      else open++;
    }
  }
  events.sort((a, b) => a.at - b.at);
  const summary: HarnessSummary = {
    ...claudeProbe({ now, store: dir }),
    events: events.length,
    from: events.length ? events[0].at : null,
    to: events.length ? events[events.length - 1].at : null,
    turns,
    open,
  };
  return { events, summary };
}

export const claudeReader: HarnessReader = { id: "claude", source: "claude", probe: claudeProbe, read: readClaude };
