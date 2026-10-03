/**
 * The report projection. Bend owns the totals; this file owns only attribution
 * and coverage, and it never adds two measures together.
 */
import { reconcileIntervals } from "../core/native.ts";
import type { Interval } from "../core/ledger.ts";
import { clockScope, type Observation, type WorkspanStore } from "./db.ts";
import type { EngineInfo } from "./engine.ts";

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
  // A sweep, not a scan per boundary: the previous version walked every interval for
  // every elementary segment, so a year of history (tens of thousands of windows)
  // turned each report into seconds of work. This is O(n log n) and keeps the same
  // semantics: disjoint parts that cover the union exactly.
  type Point = { at: number; delta: 1 | -1; project?: string };
  const points: Point[] = [];
  for (const interval of intervals) {
    if (interval.end <= interval.start) continue;
    points.push({ at: interval.start, delta: 1, ...(interval.project ? { project: interval.project } : {}) });
    points.push({ at: interval.end, delta: -1, ...(interval.project ? { project: interval.project } : {}) });
  }
  // Ends sort before starts at the same instant, so touching intervals are not
  // treated as overlapping.
  points.sort((a, b) => a.at - b.at || a.delta - b.delta);

  const claims = new Map<string, number>();
  const projects = new Map<string, number>();
  let active = 0, unclaimed = 0, unallocated = 0, ambiguous = 0;
  let previous: number | null = null;
  let index = 0;
  while (index < points.length) {
    const at = points[index].at;
    if (previous !== null && at > previous && active > 0) {
      const ms = at - previous;
      if (claims.size > 1) ambiguous += ms;
      else if (claims.size === 1 && unclaimed === 0) {
        const only = claims.keys().next().value as string;
        projects.set(only, (projects.get(only) ?? 0) + ms);
      } else unallocated += ms;
    }
    while (index < points.length && points[index].at === at) {
      const point = points[index++];
      if (point.delta === 1) {
        active++;
        if (point.project) claims.set(point.project, (claims.get(point.project) ?? 0) + 1);
        else unclaimed++;
      } else {
        active--;
        if (point.project) {
          const remaining = (claims.get(point.project) ?? 0) - 1;
          if (remaining > 0) claims.set(point.project, remaining); else claims.delete(point.project);
        } else unclaimed--;
      }
    }
    previous = at;
  }
  return { projects, unallocated, ambiguous, total: totalOf(sweep(intervals)) };
}

function measure(intervals: readonly Attributed[]): MeasureStatus {
  const part = partitionByProject(intervals);
  const union = intervals.length === 0 ? 0 : reconcileIntervals([intervals.map(({ start, end }) => ({ start, end }))])[0];
  return {
    union_ms: union,
    // A zero-duration project is a boundary, not information: keep the totals
    // honest without listing names that carry no time.
    projects: [...part.projects.entries()].map(([project, ms]) => ({ project, ms })).filter(row => row.ms > 0).sort((a, b) => b.ms - a.ms || a.project.localeCompare(b.project)),
    unallocated_ms: part.unallocated,
    ambiguous_ms: part.ambiguous,
  };
}

export interface Status {
  schema: 1;
  generated_at: number;
  idle_gap_ms: number;
  /** Which accounting engine produced these numbers, and what it is. */
  engine: EngineInfo | null;
  measures: Record<MeasureName, MeasureStatus>;
  /** `id` is the internal key; `session` is what session.stop takes back. */
  current_session: { id: string; session: string; project: string | null; root: string | null; started_at: number; state: "running" | "paused"; paused_ms: number; paused_at: number | null; provisional_ms: number } | null;
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

/**
 * Pair agent-turn evidence into intervals. Exported because the migration
 * reconciler must count imported evidence exactly as the report does.
 */
export function agentIntervals(observations: readonly Observation[]): { intervals: Attributed[]; open: number } {
  const intervals: Attributed[] = [];
  // A turn is paired per source session: the completion is a separate event with
  // its own id, so identity is the session, not the start event.
  const starts = new Map<string, { at: number; project?: string }>();
  for (const event of observations) {
    const key = [event.source, event.instance, event.session].join("\u0000");
    if (event.kind === "agent-start") starts.set(key, { at: event.at, project: event.project });
    // An end without a start is not evidence of a duration, so it contributes nothing.
    if (event.kind === "agent-end") {
      const start = starts.get(key);
      if (start) { intervals.push({ start: start.at, end: event.at, project: start.project ?? event.project }); starts.delete(key); }
    }
  }
  return { intervals, open: starts.size };
}

/**
 * The expensive half of a status: everything derived from the evidence and the
 * policy, and nothing derived from the clock. Recomputing it costs a Bend union
 * over every interval — hundreds of milliseconds at a few thousand windows — while
 * the live fields cost nothing, so the two are separated and the projection is held
 * against a watermark, as the architecture specifies for derived views.
 */
interface Projection {
  measures: Record<MeasureName, MeasureStatus>;
  coverage: Status["coverage"];
  /** Cached without the provisional duration, which is a function of the current time. */
  session: { id: string; session: string; project: string | null; root: string | null; started_at: number; state: "running" | "paused"; paused_ms: number; paused_at: number | null } | null;
  observations: number;
  conflicts: number;
}

/** Caller-owned cache slot, so the projection is not module state. */
export interface StatusCache {
  key?: string;
  /** Recomputation count: a cache hit leaves it unchanged, which a test can assert. */
  builds?: number;
  projection?: Projection;
}

/** Evidence revision, policy identity and idle policy: everything the projection depends on. */
function projectionKey(store: WorkspanStore, options: { idleGapMs: number; engine?: EngineInfo }): string {
  const engine = options.engine ? options.engine.label + "/" + (options.engine.digest ?? "none") : "none";
  return store.revision() + "|" + options.idleGapMs + "|" + engine;
}

/**
 * The active spans of a session: its interval minus every pause. A paused span is not
 * attested work, and a session stopped while paused keeps no trailing span.
 */
export function activeSpans(startedAt: number, endedAt: number, transitions: ReadonlyArray<{ kind: "pause" | "resume"; at: number }>): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let cursor = startedAt;
  let pausedAt: number | null = null;
  for (const transition of transitions) {
    if (transition.kind === "pause" && pausedAt === null) {
      if (transition.at > cursor) spans.push({ start: cursor, end: Math.min(transition.at, endedAt) });
      pausedAt = transition.at;
    } else if (transition.kind === "resume" && pausedAt !== null) {
      pausedAt = null;
      cursor = Math.max(cursor, transition.at);
    }
  }
  if (pausedAt === null && endedAt > cursor) spans.push({ start: cursor, end: endedAt });
  return spans;
}

/** How much time before `boundary` was spent paused. An open pause is not counted: it is what freezes the clock. */
export function pausedSpanMs(transitions: ReadonlyArray<{ kind: "pause" | "resume"; at: number }>, boundary: number): number {
  let total = 0;
  let pausedAt: number | null = null;
  for (const transition of transitions) {
    if (transition.kind === "pause" && pausedAt === null) pausedAt = transition.at;
    else if (transition.kind === "resume" && pausedAt !== null) {
      total += Math.max(0, Math.min(transition.at, boundary) - pausedAt);
      pausedAt = null;
    }
  }
  return total;
}

function computeProjection(store: WorkspanStore, options: { idleGapMs: number }): Projection {
  const observations = store.observations();
  const windows = store.windows();
  const sessions = store.sessionRows();
  const conflicts = store.conflictRows();

  // Attested: only user-stated intervals, minus the spans the user paused. A paused
  // span is not attested work, and the provisional clock freezes while paused.
  const transitions = store.sessionTransitions();
  const attested: Attributed[] = [];
  let openSessions = 0;
  let current: Projection["session"] = null;
  for (const row of sessions) {
    const rowTransitions = transitions.filter(t => t.sessionId === row.id && t.at >= row.startedAt);
    const openPause = rowTransitions.length % 2 === 1 ? rowTransitions[rowTransitions.length - 1].at : null;
    // Completed pauses are excluded from the provisional total; the open pause is
    // what freezes the clock, so it is not counted as paused time as well.
    const pausedMs = pausedSpanMs(rowTransitions, openPause ?? Number.MAX_SAFE_INTEGER);
    if (row.endedAt === null) {
      openSessions++;
      current = { id: row.id, session: row.session, project: row.project, root: row.root, started_at: row.startedAt, state: row.state === "paused" ? "paused" : "running", paused_ms: pausedMs, paused_at: openPause };
      continue;
    }
    for (const span of activeSpans(row.startedAt, row.endedAt, rowTransitions)) {
      attested.push({ start: span.start, end: span.end, project: row.project ?? undefined });
    }
  }

  // Inferred: window evidence from human interaction, policy owned by core/clock.ts.
  // Attribution uses the window's client label, not its root path: a window knows
  // which project it belongs to, and the root stays the key a binding is made
  // against. A clock-written window sets both from the same value.
  const inferred: Attributed[] = windows
    .filter(w => w.kind === "work")
    .map(w => ({ start: w.start, end: w.end, project: w.client === "" || w.client === "unallocated" ? undefined : w.client }));

  // Agent runtime: paired turn evidence. A turn with no end stays open and visible.
  const { intervals: agent, open: openTurns } = agentIntervals(observations);

  return {
    measures: { attested: measure(attested), inferred: measure(inferred), agent: measure(agent) },
    coverage: { events: observations.length, conflicts: conflicts.length, open_agent_turns: openTurns, open_sessions: openSessions, sources: store.sources() },
    session: current,
    observations: observations.length,
    conflicts: conflicts.length,
  };
}

export function buildStatus(store: WorkspanStore, options: { idleGapMs: number; now?: number; engine?: EngineInfo; cache?: StatusCache }): Status {
  const now = options.now ?? Date.now();
  const key = options.cache ? projectionKey(store, options) : "";
  let projection = options.cache?.key === key ? options.cache.projection : undefined;
  if (!projection) {
    projection = computeProjection(store, options);
    if (options.cache) {
      options.cache.key = key;
      options.cache.projection = projection;
      options.cache.builds = (options.cache.builds ?? 0) + 1;
    }
  }
  return {
    schema: 1,
    generated_at: now,
    idle_gap_ms: options.idleGapMs,
    engine: options.engine ?? null,
    measures: projection.measures,
    current_session: projection.session
      ? {
        ...projection.session,
        provisional_ms: Math.max(0, (projection.session.state === "paused" ? projection.session.paused_at ?? projection.session.started_at : now) - projection.session.started_at - projection.session.paused_ms),
      }
      : null,
    coverage: projection.coverage,
    watermark: { observations: projection.observations, conflicts: projection.conflicts },
    non_additive: NON_ADDITIVE_NOTE,
  };
}

/** Scope used to drive the inferred-window policy for one observation. */
export function scopeFor(attribution: { root?: string; project?: string }, session: string) { return clockScope(attribution, session); }
