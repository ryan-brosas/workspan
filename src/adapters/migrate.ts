/**
 * Migrate an existing Pi tracker into a Workspan database.
 *
 * Three properties matter more than speed:
 *   1. It never writes to a live database by accident. The target is explicit and
 *      the daemon's own database is refused unless `allowLiveDatabase` is set.
 *   2. It reconciles what it imported, for both measures, by unioning the source
 *      evidence and the imported evidence with Bend and comparing them.
 *   3. It imports the tracker's own attribution rather than inventing one, and marks
 *      labels the tracker never confirmed as provisional.
 *
 * Which source carries which measure:
 *   chunks  -> agent runtime   (a Pi turn running is not attendance)
 *   windows -> inferred attended windows (they are the tracker's own evidence for it)
 *   workspaces -> project bindings, with the tracker's own `explicit` flag
 *   summaries  -> audited, never imported (they describe durability, not time)
 */
import { resolve } from "node:path";
import { WorkspanStore } from "../daemon/db.ts";
import { agentIntervals } from "../daemon/measures.ts";
import { defaultDatabasePath } from "../daemon/paths.ts";
import { reconcileIntervals, type NativeOptions } from "../core/native.ts";
import { planPiHistory, type PiHistoryPlan } from "./pi-history.ts";
import { readTrackerHistory, TRACKER_SOURCE, type TrackerHistory } from "./tracker-history.ts";

export interface MigrationOptions extends NativeOptions {
  chunksLog: string;
  targetDatabase: string;
  /** The existing tracker's SQLite database: bindings and inferred windows. */
  trackerDatabase?: string;
  /** Explicit `scope` or scope prefix to project mapping, for the chunk ledger. */
  scopeMap?: Record<string, string>;
  instance?: string;
  /** Write to the target. Without it the migration only plans. */
  apply?: boolean;
  /** Required to write into the daemon's own database. */
  allowLiveDatabase?: boolean;
}

export interface MigrationReport {
  target: string;
  applied: boolean;
  plan: Pick<PiHistoryPlan, "scopes" | "unmapped" | "input"> & { events: number };
  tracker: (Pick<TrackerHistory, "skipped_windows"> & { bindings: number; windows: number; provisional_projects: string[] }) | null;
  written: { accepted: number; duplicates: number; conflicts: number; windows: number; bindings: number } | null;
  reconciliation: {
    agent: { source_ms: number; target_ms: number; equal: boolean };
    inferred: { source_ms: number; target_ms: number; equal: boolean };
    identities: number;
    open_turns: number;
  } | null;
}

const unionOf = (intervals: Array<{ start: number; end: number }>, options: NativeOptions): number =>
  intervals.length ? reconcileIntervals([intervals], options)[0] : 0;

export function migratePiHistory(options: MigrationOptions): MigrationReport {
  const plan = planPiHistory({ chunksLog: options.chunksLog, ...(options.scopeMap ? { scopeMap: options.scopeMap } : {}), ...(options.instance ? { instance: options.instance } : {}) });
  const tracker = options.trackerDatabase ? readTrackerHistory(options.trackerDatabase) : null;
  const target = resolve(options.targetDatabase);
  const report: MigrationReport = {
    target,
    applied: false,
    plan: { scopes: plan.scopes, unmapped: plan.unmapped, input: plan.input, events: plan.events.length },
    tracker: tracker
      ? {
          bindings: tracker.bindings.length,
          windows: tracker.windows.length,
          skipped_windows: tracker.skipped_windows,
          provisional_projects: [...new Set(tracker.bindings.filter(b => !b.explicit).map(b => b.project))].sort(),
        }
      : null,
    written: null,
    reconciliation: null,
  };
  if (!options.apply) return report;

  if (target === resolve(defaultDatabasePath()) && !options.allowLiveDatabase) {
    throw new Error("refusing to migrate into the daemon's own database; pass --allow-live-database if that is really intended");
  }

  const store = new WorkspanStore(target);
  try {
    if (tracker) {
      for (const binding of tracker.bindings) store.bindProject(binding.root, binding.project, binding.explicit, TRACKER_SOURCE);
      for (const window of tracker.windows) {
        // Stable identity: the tracker's own window id, so a replay upserts the same row.
        store.save({ id: `${TRACKER_SOURCE}:${window.id}`, root: window.root, client: window.client, sessionId: window.sessionId, task: window.task, start: window.start, end: window.end, kind: "work" });
      }
    }

    const written = { accepted: 0, duplicates: 0, conflicts: 0, windows: tracker?.windows.length ?? 0, bindings: tracker?.bindings.length ?? 0 };
    for (const event of plan.events) {
      const result = store.ingest(event, Date.now());
      if (result.status === "accepted") written.accepted++;
      else if (result.status === "duplicate") written.duplicates++;
      else written.conflicts++;
    }

    const instance = plan.input.instance;
    const migrated = store.observations().filter(o => o.source === "pi" && o.instance === instance);
    const { intervals, open } = agentIntervals(migrated);

    // Agent runtime comes from the chunk ledger; inferred attendance from the windows.
    const sourceAgentMs = unionOf(plan.events.filter(e => e.kind === "agent-start").map(e => {
      const end = plan.events.find(other => other.kind === "agent-end" && other.session === e.session && other.event === e.event.replace(/:start$/, ":end"));
      return { start: e.at, end: end ? end.at : e.at };
    }), options);
    const targetAgentMs = unionOf(intervals.map(({ start, end }) => ({ start, end })), options);
    const sourceInferredMs = unionOf((tracker?.windows ?? []).map(w => ({ start: w.start, end: w.end })), options);
    const targetInferredMs = unionOf(store.windows().filter(w => w.kind === "work").map(w => ({ start: w.start, end: w.end })), options);

    report.applied = true;
    report.written = written;
    report.reconciliation = {
      agent: { source_ms: sourceAgentMs, target_ms: targetAgentMs, equal: sourceAgentMs === targetAgentMs },
      inferred: { source_ms: sourceInferredMs, target_ms: targetInferredMs, equal: sourceInferredMs === targetInferredMs },
      identities: migrated.length,
      open_turns: open,
    };
    return report;
  } finally { store.close(); }
}
