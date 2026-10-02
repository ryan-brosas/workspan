/**
 * Migrate an existing Pi tracker's counted evidence into a Workspan database.
 *
 * Two properties matter more than speed:
 *   1. It never writes to a live database by accident. The target is explicit and
 *      the daemon's own database is refused unless `allowLiveDatabase` is set.
 *   2. It reconciles what it imported. The source counted evidence and the imported
 *      agent-runtime measure are both unioned by Bend and compared; the migration
 *      is not reported as successful when they disagree.
 *
 * Summaries are audited, never imported: they describe durability, not time.
 */
import { resolve } from "node:path";
import { WorkspanStore } from "../daemon/db.ts";
import { agentIntervals } from "../daemon/measures.ts";
import { defaultDatabasePath } from "../daemon/paths.ts";
import { reconcileIntervals, type NativeOptions } from "../core/native.ts";
import type { ReceiptAuditReport } from "./receipt-audit.ts";
import { planPiHistory, type PiHistoryPlan } from "./pi-history.ts";

export interface MigrationOptions extends NativeOptions {
  chunksLog: string;
  targetDatabase: string;
  /** Explicit `scope` or scope prefix to project mapping. */
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
  written: { accepted: number; duplicates: number; conflicts: number } | null;
  reconciliation: {
    /** Counted evidence in the source, unioned by Bend. */
    source_ms: number;
    /** The same evidence as the target's agent-runtime measure, unioned by Bend. */
    target_ms: number;
    equal: boolean;
    identities: number;
    open_turns: number;
  } | null;
  audit: ReceiptAuditReport | null;
}

export function migratePiHistory(options: MigrationOptions): MigrationReport {
  const plan = planPiHistory({ chunksLog: options.chunksLog, ...(options.scopeMap ? { scopeMap: options.scopeMap } : {}), ...(options.instance ? { instance: options.instance } : {}) });
  const target = resolve(options.targetDatabase);
  const report: MigrationReport = {
    target,
    applied: false,
    plan: { scopes: plan.scopes, unmapped: plan.unmapped, input: plan.input, events: plan.events.length },
    written: null,
    reconciliation: null,
    audit: null,
  };
  if (!options.apply) return report;

  if (target === resolve(defaultDatabasePath()) && !options.allowLiveDatabase) {
    throw new Error("refusing to migrate into the daemon's own database; pass --allow-live-database if that is really intended");
  }

  // The source total: the same intervals the events carry, unioned by Bend.
  const sourceIntervals = plan.events.filter(e => e.kind === "agent-start").map(e => {
    const end = plan.events.find(other => other.kind === "agent-end" && other.session === e.session && other.event === e.event.replace(/:start$/, ":end"));
    return { start: e.at, end: end ? end.at : e.at };
  });
  const sourceMs = sourceIntervals.length ? reconcileIntervals([sourceIntervals], options)[0] : 0;

  const store = new WorkspanStore(target);
  try {
    const written = { accepted: 0, duplicates: 0, conflicts: 0 };
    for (const event of plan.events) {
      const result = store.ingest(event, Date.now());
      if (result.status === "accepted") written.accepted++;
      else if (result.status === "duplicate") written.duplicates++;
      else written.conflicts++;
    }
    const instance = plan.input.instance;
    const migrated = store.observations().filter(o => o.source === "pi" && o.instance === instance);
    const { intervals, open } = agentIntervals(migrated);
    const targetMs = intervals.length ? reconcileIntervals([intervals.map(({ start, end }) => ({ start, end }))], options)[0] : 0;
    report.applied = true;
    report.written = written;
    report.reconciliation = { source_ms: sourceMs, target_ms: targetMs, equal: sourceMs === targetMs, identities: migrated.length, open_turns: open };
    return report;
  } finally { store.close(); }
}
