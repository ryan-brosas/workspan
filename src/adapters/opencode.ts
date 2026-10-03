/**
 * opencode adapter: agent activity from the local store, timing only.
 *
 * opencode keeps no turn table, so messages pair into activity blocks:
 * consecutive messages of one session merge while the silence stays under
 * SETTLE_GAP_MS, and only a settled block gets an end - an unfinished block
 * stays visible as an open turn. The `data` column is never selected: the
 * select list is the privacy boundary and is tested as such.
 */
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EvidenceEvent } from "../daemon/evidence.ts";
import { SETTLE_GAP_MS, emptySummary, mtimeOf, rootOfDirectory, staleDaysOf, toMs, unavailable, type HarnessProbe, type HarnessReadOptions, type HarnessReader, type HarnessSummary } from "./harness.ts";

export function defaultOpencodeDbPath(): string {
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode", "opencode.db");
}

/** Timing, identity and workspace columns only. The select list is the privacy boundary. */
export const OPENCODE_QUERY = `
select m.session_id as session_id, m.time_created as started, m.time_updated as ended, s.directory as directory
from message m
left join session s on s.id = m.session_id
where coalesce(m.time_updated, m.time_created) >= ?
order by m.session_id asc, m.time_created asc, m.id asc
limit ?
`;

export interface OpencodeBlock { session: string; start: number; end: number; directory: string | null }

/** Consecutive messages of one session merge while the silence stays under the gap. */
export function mergeBlocks(rows: readonly OpencodeBlock[]): OpencodeBlock[] {
  const blocks: OpencodeBlock[] = [];
  for (const row of rows) {
    const last = blocks[blocks.length - 1];
    if (last && last.session === row.session && row.start - last.end <= SETTLE_GAP_MS) {
      last.end = Math.max(last.end, row.end);
      if (!last.directory && row.directory) last.directory = row.directory;
    } else blocks.push({ ...row });
  }
  return blocks;
}

function hasMessageTiming(path: string): boolean {
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    try { return db.prepare("select 1 from sqlite_master where type = 'table' and name = 'message'").get() !== undefined; }
    finally { db.close(); }
  } catch { return false; }
}

export function discoverOpencodeStore(dbPath: string = defaultOpencodeDbPath()): string | null {
  return mtimeOf(dbPath) !== null && hasMessageTiming(dbPath) ? dbPath : null;
}

function freshness(dbPath: string, now: number): HarnessProbe {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("select max(coalesce(time_updated, time_created)) as value from message").get() as { value?: unknown } | undefined;
    const lastEventAt = toMs(row?.value);
    return { store: dbPath, storeMtime: mtimeOf(dbPath), lastEventAt, staleDays: staleDaysOf(now, lastEventAt) };
  } finally { db.close(); }
}

export function opencodeProbe(options: { now?: number; store?: string } = {}): HarnessProbe {
  const dbPath = options.store ?? discoverOpencodeStore();
  if (dbPath === null || mtimeOf(dbPath) === null) return unavailable();
  return freshness(dbPath, options.now ?? Date.now());
}

export function readOpencode(options: HarnessReadOptions = {}): { events: EvidenceEvent[]; summary: HarnessSummary } {
  const dbPath = options.store ?? discoverOpencodeStore();
  const now = options.now ?? Date.now();
  const sinceMs = options.sinceMs ?? now - 86_400_000;
  const limit = Math.min(Math.max(1, options.limit ?? 5000), 50_000);
  const instance = options.instance ?? "local";
  if (dbPath === null || mtimeOf(dbPath) === null) return { events: [], summary: emptySummary() };

  const db = new DatabaseSync(dbPath, { readOnly: true });
  let rows: OpencodeBlock[];
  try {
    const raw = db.prepare(OPENCODE_QUERY).all(Math.floor(sinceMs), limit) as Array<Record<string, unknown>>;
    rows = [];
    for (const row of raw) {
      const start = toMs(row.started);
      if (start === null) continue;
      const end = toMs(row.ended) ?? start;
      rows.push({
        session: String(row.session_id),
        start,
        end: Math.max(start, end),
        directory: typeof row.directory === "string" && row.directory ? row.directory : null,
      });
    }
  } finally { db.close(); }

  const blocks = mergeBlocks(rows);
  // A block is settled when a later block of its session follows, or the silence
  // has lasted; an unsettled block keeps its start visible without claiming an end.
  const events: EvidenceEvent[] = [];
  let open = 0;
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    const root = rootOfDirectory(block.directory);
    const base = { source: "opencode" as const, instance, session: block.session, ...(root ? { root } : {}) };
    events.push({ ...base, event: `block-${block.start}:start`, kind: "agent-start", at: block.start, origin: "automated" });
    const next = blocks[index + 1];
    const settled = (next !== undefined && next.session === block.session) || now - block.end >= SETTLE_GAP_MS;
    if (settled) events.push({ ...base, event: `block-${block.start}:end`, kind: "agent-end", at: block.end, origin: "automated" });
    else open++;
  }
  events.sort((a, b) => a.at - b.at);
  const summary: HarnessSummary = {
    ...freshness(dbPath, now),
    events: events.length,
    from: events.length ? events[0].at : null,
    to: events.length ? events[events.length - 1].at : null,
    blocks: blocks.length,
    open,
  };
  return { events, summary };
}

export const opencodeReader: HarnessReader = { id: "opencode", source: "opencode", probe: opencodeProbe, read: readOpencode };
