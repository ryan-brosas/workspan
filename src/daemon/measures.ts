/**
 * The report projection. Bend owns the totals; this file owns only attribution
 * and coverage, and it never adds two measures together.
 */
import { reconcileIntervals } from "../core/native.ts";
import type { Interval } from "../core/ledger.ts";
import { clockScope, type WorkspanStore } from "./db.ts";

export const MEASURES = ["attested", "inferred", "agent"] as const;
export type MeasureName = typeof MEASURES[number];

export const NON_ADDITIVE_NOTE = "attested, inferred and agent runtime are separate measures and are never added together";

export interface Segment { start: number; end: number }
export interface Attributed { start: number; end: number; project?: string }

export interface MeasureStatus {
  /** Union duration for the whole measure, produced by the Bend policy. */
  union_ms: number;
  /** Union duration per project. Segments are disjoint, so these never double count. */
  projects: Array<{ project: string; ms: number }>;
  /** Union time whose evidence carries no project. Never a guessed client. */
  unallocated_ms: number;
  /** Union time claimed by more than one project. Requires review, never split. */
  ambiguous_ms: number;
}

/** Disjoint segments covering the union of `intervals`. Derived view, not a second authority. */
export function sweep(intervals: readonly Interval[]): Segment[] {
  const sorted = intervals.filter(i => i.end > i.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Segment[] = [];
  for (const { start, end } of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last.end) { if (end > last.end) last.end = end; }
    else out.push({ start, end });
  }
  return out;
}

export const totalOf = (segments: readonly Segment[]): number => segments.reduce((sum, s) => sum + (s.end - s.start), 0);

/**
 * Partition the measure's union at assignment boundaries, not at union
 * boundaries. Every elementary segment between two evidence endpoints is
 * allocated to one project, left unallocated, or flagged ambiguous; the parts are
 * disjoint and cover the union exactly, which is what stops one hour from being
 * billed to two clients. Contiguous evidence with different attribution is *not*
 * merged: a projectless stretch next to a claimed one stays visible.
 */
export function partitionByProject(intervals: readonly Attributed[]): { projects: Map<string, number>; unallocated: number; ambiguous: number; total: number } {
  const boundaries = [...new Set(intervals.flatMap(i => [i.start, i.end]))].sort((a, b) => a - b);
  const projects = new Map<string, number>();
  let unallocated = 0, ambiguous = 0;
  for (let i = 0; i + 1 < boundaries.length; i++) {
    const start = boundaries[i], end = boundaries[i + 1];
    if (end <= start) continue;
    const claims = new Set<string>();
    let uncovered = true, unclaimed = false;
    for (const interval of intervals) {
      if (interval.start < end && interval.end > start) {
        uncovered = false;
        if (interval.project) claims.add(interval.project);
        else unclaimed = true;
      }
    }
    if (uncovered) continue;
    const ms = end - start;
    if (claims.size > 1) ambiguous += ms;
    else if (claims.size === 1 && !unclaimed) projects.set([...claims][0], (projects.get([...claims][0]) ?? 0) + ms);
    else unallocated += ms;
  }
  return { projects, unallocated, ambiguous, total: totalOf(sweep(intervals)) };
}

function measure(intervals: readonly Attributed[]): MeasureStatus {
  const part = partitionByProject(intervals);
  const union = intervals.length === 0 ? 0 : reconcileIntervals([intervals.map(({ start, end }) => ({ start, end }))])[0];
  return {
    union_ms: union,
    projects: [...part.projects.entries()].map(([project, ms]) => ({ project, ms })).sort((a, b) => b.ms - a.ms || a.project.localeCompare(b.project)),
    unallocated_ms: part.unallocated,
    ambiguous_ms: part.ambiguous,
  };
}

export interface Status {
  schema: 1;
  generated_at: number;
  idle_gap_ms: number;
  measures: Record<MeasureName, MeasureStatus>;
  /** `id` is the internal key; `session` is what session.stop takes back. */
  current_session: { id: string; session: string; project: string | null; started_at: number; provisional_ms: number } | null;
  coverage: {
    events: number;
    conflicts: number;
    open_agent_turns: number;
    open_sessions: number;
    sources: Array<{ source: string; events: number; cursor: number }>;
  };
  watermark: { observations: number; conflicts: number };
  non_additive: string;
}

export function buildStatus(store: WorkspanStore, options: { idleGapMs: number; now?: number }): Status {
  const now = options.now ?? Date.now();
  const observations = store.observations();
  const windows = store.windows();
  const sessions = store.sessionRows();
  const conflicts = store.conflictRows();

  // Attested: only user-stated intervals. A running session is provisional.
  const attested: Attributed[] = [];
  let openSessions = 0;
  let current: Status["current_session"] = null;
  for (const row of sessions) {
    if (row.endedAt === null) {
      openSessions++;
      current = { id: row.id, session: row.session, project: row.project, started_at: row.startedAt, provisional_ms: Math.max(0, now - row.startedAt) };
      continue;
    }
    attested.push({ start: row.startedAt, end: row.endedAt, project: row.project ?? undefined });
  }

  // Inferred: window evidence from human interaction, policy owned by core/clock.ts.
  const inferred: Attributed[] = windows
    .filter(w => w.kind === "work")
    .map(w => ({ start: w.start, end: w.end, project: w.root === "" ? undefined : w.root }));

  // Agent runtime: paired turn evidence. A turn with no end stays open and visible.
  const agent: Attributed[] = [];
  // A turn is paired per source session: the completion is a separate event with
  // its own id, so identity is the session, not the start event.
  const starts = new Map<string, { at: number; project?: string }>();
  for (const event of observations) {
    const key = [event.source, event.instance, event.session].join("\u0000");
    if (event.kind === "agent-start") starts.set(key, { at: event.at, project: event.project });
    // An end without a start is not evidence of a duration, so it contributes nothing.
    if (event.kind === "agent-end") {
      const start = starts.get(key);
      if (start) { agent.push({ start: start.at, end: event.at, project: start.project ?? event.project }); starts.delete(key); }
    }
  }
  const openTurns = starts.size;

  return {
    schema: 1,
    generated_at: now,
    idle_gap_ms: options.idleGapMs,
    measures: { attested: measure(attested), inferred: measure(inferred), agent: measure(agent) },
    current_session: current,
    coverage: { events: observations.length, conflicts: conflicts.length, open_agent_turns: openTurns, open_sessions: openSessions, sources: store.sources() },
    watermark: { observations: observations.length, conflicts: conflicts.length },
    non_additive: NON_ADDITIVE_NOTE,
  };
}

/** Scope used to drive the inferred-window policy for one observation. */
export function scopeFor(project: string | undefined, session: string) { return clockScope(project, session); }
