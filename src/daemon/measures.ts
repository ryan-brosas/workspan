/**
 * The report projection. Bend owns the totals; this file owns only attribution
 * and coverage, and it never adds two measures together.
 */
import { reconcileIntervals } from "../core/native.ts";
import type { Interval } from "../core/ledger.ts";
import { clockScope, type Observation, type SessionRow, type WorkspanStore } from "./db.ts";
import type { EngineInfo } from "./engine.ts";

export const MEASURES = ["attested", "inferred", "agent"] as const;
export type MeasureName = typeof MEASURES[number];

export const NON_ADDITIVE_NOTE = "attested, inferred and agent runtime are separate measures and are never added together";

export interface Segment { start: number; end: number }
export interface Attributed { start: number; end: number; project?: string; root?: string }

export interface MeasureStatus {
  /** Union duration for the whole measure, produced by the Bend policy. */
  union_ms: number;
  /** Union duration per project. Segments are disjoint, so these never double count. */
  projects: Array<{ project: string; ms: number }>;
  /** Union time whose evidence carries no project. Never a guessed client. */
  unallocated_ms: number;
  /**
   * Where that unallocated time came from, per workspace root. It is what turns a
   * bare total into an offer: name the directory and the time has a client. Roots
   * are never guessed from an application name, and the parts are unions per root.
   */
  unallocated_roots: Array<{ root: string; ms: number }>;
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

/** Union of the intervals that carry this root and no project. Never a raw sum. */
function unallocatedByRoot(intervals: readonly Attributed[]): Array<{ root: string; ms: number }> {
  const byRoot = new Map<string, Interval[]>();
  for (const interval of intervals) {
    if (!interval.root || interval.project || interval.end <= interval.start) continue;
    const list = byRoot.get(interval.root);
    if (list) list.push({ start: interval.start, end: interval.end });
    else byRoot.set(interval.root, [{ start: interval.start, end: interval.end }]);
  }
  return [...byRoot.entries()]
    .map(([root, list]) => ({ root, ms: totalOf(sweep(list)) }))
    .filter(row => row.ms > 0)
    .sort((a, b) => b.ms - a.ms || a.root.localeCompare(b.root));
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
    unallocated_roots: unallocatedByRoot(intervals),
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
  /**
   * The latest seat idle stretch: an annotation from the collector, never a measure.
   * `idle_ms` is live while the stretch is open; nothing is paused or subtracted by it.
   */
  last_idle: { from: number; to: number | null; idle_ms: number; still_away: boolean } | null;
  /**
   * The stretches of the local day no measure covers, inside the span where evidence
   * exists. A review list, never a subtraction: it is where the report cannot speak.
   */
  uncovered: { today_ms: number; stretches: Array<{ start: number; end: number }> };
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
  const starts = new Map<string, { at: number; project?: string; root?: string }>();
  for (const event of observations) {
    const key = [event.source, event.instance, event.session].join("\u0000");
    if (event.kind === "agent-start") starts.set(key, { at: event.at, project: event.project, root: event.root });
    // An end without a start is not evidence of a duration, so it contributes nothing.
    if (event.kind === "agent-end") {
      const start = starts.get(key);
      if (start) { intervals.push({ start: start.at, end: event.at, project: start.project ?? event.project, root: start.root ?? event.root }); starts.delete(key); }
    }
  }
  return { intervals, open: starts.size };
}

/** The collector refuses to arm a notification beyond a day; a token that claims more is not one to interpret. */
const MAX_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export interface IdleStretch {
  /** Start of the quiet stretch: the notification stamp minus the timeout it waited out. */
  from: number;
  /** First input afterwards; `null` while the seat is still quiet. */
  to: number | null;
}

/**
 * Seat idle stretches, from the collector's annotations only. The collector writes
 * `idle:<at>:<timeout>` and `resumed:<at>:<timeout>`, so the quiet stretch began at
 * `at - timeout`: that subtraction is what makes the start provable rather than
 * guessed, since the protocol guarantees the timeout elapsed before it fired.
 *
 * A stretch never reaches a measure. No seat input is not the same as no work -
 * reading, a call or a meeting all look quiet - so this is a review item, and only
 * the person's own session evidence says what it was.
 */
export function idleStretches(observations: readonly Observation[]): IdleStretch[] {
  const stretches: IdleStretch[] = [];
  let open: number | null = null;
  for (const event of observations) {
    if (event.source !== "desktop" || event.kind !== "interaction") continue;
    const token = /^(idle|resumed):(\d+):(\d+)$/.exec(event.event);
    if (!token) continue;
    const timeout = Number(token[3]);
    if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_IDLE_TIMEOUT_MS) continue;
    if (token[1] === "idle") {
      const from = Math.max(0, event.at - timeout);
      // Two notifications with no resume between them are one quiet stretch, not two.
      open = open === null ? from : Math.min(open, from);
    } else if (open !== null) {
      // A resume before the stretch began is not evidence of a stretch: it closes
      // the open one and contributes nothing, rather than inventing an interval.
      if (event.at > open) stretches.push({ from: open, to: event.at });
      open = null;
    }
  }
  if (open !== null) stretches.push({ from: open, to: null });
  return stretches;
}

/**
 * Idle-inhibitor stretches, from the collector's annotations only. `inhibit-idle` says
 * the focused window asked the compositor to stay awake and `inhibit-cleared` says it
 * stopped. It is the mirror image of `idleStretches` and just as far from a measure: a
 * machine held awake proves something was running, never that a person was working, and
 * an inhibitor with no clear is reported open rather than invented.
 */
export function inhibitStretches(observations: readonly Observation[]): IdleStretch[] {
  const stretches: IdleStretch[] = [];
  let open: number | null = null;
  for (const event of observations) {
    if (event.source !== "desktop" || event.kind !== "interaction") continue;
    const token = /^(inhibit-idle|inhibit-cleared):(\d+)$/.exec(event.event);
    if (!token) continue;
    if (token[1] === "inhibit-idle") {
      // Two holds with no clear between them are one stretch, not two.
      open = open === null ? event.at : Math.min(open, event.at);
    } else if (open !== null) {
      if (event.at > open) stretches.push({ from: open, to: event.at });
      open = null;
    }
  }
  if (open !== null) stretches.push({ from: open, to: null });
  return stretches;
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
  /** The latest stretch only: closed duration is evidence, an open one is drawn live. */
  lastIdle: IdleStretch | null;
  /** Every interval the measures were built from, kept so a review view needs no rebuild. */
  intervals: { attested: Attributed[]; inferred: Attributed[]; agent: Attributed[] };
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

/**
 * The session whose wall interval covers `at`. This is what a review note attaches
 * to, so a stretch is never attributed to whatever happens to be open now; pauses do
 * not narrow the interval, because a note describes what a session was rather than
 * what it counts, and the latest start wins if two intervals overlap after a manual
 * correction. A removed session is a correction, not a place to put new evidence.
 */
/**
 * Where evidence exists at all: the earliest interval start to the latest end, clipped
 * to the bounds. A day with no intervals has no span, so nothing is called uncovered.
 */
export function observedSpan(intervals: readonly Segment[], bounds: { start: number; end: number }): { start: number; end: number } | null {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const interval of intervals) {
    if (interval.end <= bounds.start || interval.start >= bounds.end) continue;
    start = Math.min(start, Math.max(interval.start, bounds.start));
    end = Math.max(end, Math.min(interval.end, bounds.end));
  }
  return start < end ? { start, end } : null;
}

/**
 * The stretches inside `span` that no measure covers. This is the review list the
 * missing-hours diagnosis asks for: nothing here was subtracted from anything, and
 * nothing here is a work total - it is the part of the day this report cannot speak
 * for, and only the person can say what it was.
 */
export function uncoveredStretches(intervals: readonly Segment[], span: { start: number; end: number }): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let cursor = span.start;
  for (const segment of sweep(intervals.filter(interval => interval.end > interval.start))) {
    const start = Math.max(segment.start, span.start);
    const end = Math.min(segment.end, span.end);
    if (end <= cursor) continue;
    if (start > cursor) out.push({ start: cursor, end: start });
    cursor = end;
  }
  if (cursor < span.end) out.push({ start: cursor, end: span.end });
  return out;
}

export function coveringSession(rows: readonly SessionRow[], at: number): SessionRow | null {
  let best: SessionRow | null = null;
  for (const row of rows) {
    if (row.removedAt !== null) continue;
    const end = row.endedAt ?? Number.POSITIVE_INFINITY;
    if (row.startedAt <= at && at <= end && (best === null || row.startedAt > best.startedAt)) best = row;
  }
  return best;
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
    // A removed session is a recorded correction: the row stays for audit, but
    // it contributes no attested time and never becomes the current session.
    if (row.removedAt !== null) continue;
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
      attested.push({ start: span.start, end: span.end, project: row.project ?? undefined, root: row.root ?? undefined });
    }
  }

  // Inferred: window evidence from human interaction, policy owned by core/clock.ts.
  // Attribution uses the window's client label, not its root path: a window knows
  // which project it belongs to, and the root stays the key a binding is made
  // against. A clock-written window sets both from the same value.
  const inferred: Attributed[] = windows
    .filter(w => w.kind === "work")
    .map(w => ({ start: w.start, end: w.end, project: w.client === "" || w.client === "unallocated" ? undefined : w.client, root: w.root || undefined }));

  // Agent runtime: paired turn evidence. A turn with no end stays open and visible.
  const { intervals: agent, open: openTurns } = agentIntervals(observations);

  // Seat idle annotations. They are projected for review, never into a measure.
  const seatIdle = idleStretches(observations);

  return {
    measures: { attested: measure(attested), inferred: measure(inferred), agent: measure(agent) },
    coverage: { events: observations.length, conflicts: conflicts.length, open_agent_turns: openTurns, open_sessions: openSessions, sources: store.sources() },
    session: current,
    lastIdle: seatIdle.length ? seatIdle[seatIdle.length - 1] : null,
    intervals: { attested, inferred, agent },
    observations: observations.length,
    conflicts: conflicts.length,
  };
}

/**
 * The day's uncovered stretches, computed from the cached intervals: cheap enough to
 * run on every status write, and never cached, so midnight cannot make it stale.
 */
function uncoveredForDay(intervals: { attested: Attributed[]; inferred: Attributed[]; agent: Attributed[] }, day?: { start: number; end: number }): Status["uncovered"] {
  if (!day) return { today_ms: 0, stretches: [] };
  const all = [...intervals.attested, ...intervals.inferred, ...intervals.agent].map(({ start, end }) => ({ start, end }));
  const span = observedSpan(all, day);
  if (!span) return { today_ms: 0, stretches: [] };
  const stretches = uncoveredStretches(all, span);
  return { today_ms: totalOf(stretches), stretches };
}

export function buildStatus(store: WorkspanStore, options: { idleGapMs: number; now?: number; engine?: EngineInfo; cache?: StatusCache; day?: { start: number; end: number } }): Status {
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
    uncovered: uncoveredForDay(projection.intervals, options.day),
    // The cached half is the stretch itself; the duration of an open one is the
    // only field that moves with the clock, so it is computed here and not cached.
    last_idle: projection.lastIdle === null ? null : {
      from: projection.lastIdle.from,
      to: projection.lastIdle.to,
      idle_ms: Math.max(0, (projection.lastIdle.to ?? now) - projection.lastIdle.from),
      still_away: projection.lastIdle.to === null,
    },
    watermark: { observations: projection.observations, conflicts: projection.conflicts },
    non_additive: NON_ADDITIVE_NOTE,
  };
}

/** Scope used to drive the inferred-window policy for one observation. */
export function scopeFor(attribution: { root?: string; project?: string }, session: string) { return clockScope(attribution, session); }
