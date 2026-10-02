/**
 * Reads the existing Pi tracker's own database: the mappings a person already made,
 * and the inferred windows it computed from live Pi input.
 *
 * Read-only and structure-only. The tracker's `windows` rows are the evidence for
 * inferred attendance, so they are migrated as windows rather than re-derived from
 * synthesised keyboard events, and its `workspaces` rows become project bindings
 * carrying the tracker's own `explicit` flag.
 *
 * Nothing here reads a prompt, a reply or a file path beyond the workspace root.
 */
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export const TRACKER_SOURCE = "pi-time-tracker";

export interface TrackerBinding { root: string; project: string; explicit: boolean }
export interface TrackerWindow { id: string; root: string; client: string; sessionId: string; task: string; start: number; end: number }

export interface TrackerHistory {
  bindings: TrackerBinding[];
  windows: TrackerWindow[];
  skipped_windows: number;
}

export function readTrackerHistory(path: string): TrackerHistory {
  if (!existsSync(path)) throw new Error(`tracker database not found: ${path}`);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const bindings = (db.prepare("select root, client, explicit from workspaces order by root asc").all() as Record<string, unknown>[])
      .map(row => ({ root: String(row.root), project: String(row.client), explicit: Number(row.explicit) === 1 }));

    // Only work windows: `gap` rows are the tracker's record of excluded time, which
    // the union already treats as absence, so importing them would add nothing.
    // The installed schema uses camelCase `sessionId`, not `session_id`.
    const rows = db.prepare("select id, root, client, sessionId, task, start, end from windows where kind = 'work' order by start asc").all() as Record<string, unknown>[];
    const windows: TrackerWindow[] = [];
    let skipped = 0;
    for (const row of rows) {
      const start = Number(row.start);
      const end = Number(row.end);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || start < 0) { skipped++; continue; }
      windows.push({
        id: String(row.id),
        root: String(row.root), client: String(row.client), sessionId: String(row.sessionId), task: String(row.task),
        start, end,
      });
    }
    return { bindings, windows, skipped_windows: skipped };
  } finally { db.close(); }
}
