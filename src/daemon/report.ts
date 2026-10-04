/* Format-independent report facts, owned by the daemon; all durations come from Bend. */
import { localDayKey } from "../core/ledger.ts";
import { reconcileIntervals } from "../core/native.ts";
import type { WorkspanStore, Observation, SessionRow } from "./db.ts";
import { engineInfo, type EngineInfo } from "./engine.ts";
import { activeSpans, getProjection, idleStretches, inhibitStretches, measure, MEASURES, NON_ADDITIVE_NOTE, observedSpan, uncoveredStretches, type Attributed, type MeasureName, type MeasureStatus, type Status, type StatusCache } from "./measures.ts";
import { clip, dayBounds, shiftDate, weekStart, validateTimezone, type Bounds } from "./calendar.ts";

export interface ReportOptions { period?: "day" | "week"; date?: string; timezone?: string; now?: number; idleGapMs?: number; engine?: EngineInfo; cache?: StatusCache; delivery?: Status["delivery"] }
export interface SessionFact {
  session: string; project: string | null; root: string | null; state: string;
  started_at: number; ended_at: number | null; spans: Bounds[];
  worked_ms: number; paused_ms: number; provisional_ms: number | null; recorded_later: boolean; notes: string[];
}
export interface Annotation extends Bounds { open: boolean }
export interface DayFacts {
  date: string; start: number; end: number; measures: Record<MeasureName, MeasureStatus>;
  sessions: SessionFact[]; removed_sessions: number; uncovered: Bounds[]; away: Annotation[]; held_awake: Annotation[];
  collection: { counts: Record<string, number>; last_at: number | null }; events_in_range: number;
}
export interface ReportFacts {
  schema: 1; period: "day" | "week"; date: string; timezone: string; start: number; end: number; generated_at: number;
  revision: number; watermark: { observations: number; conflicts: number }; engine: EngineInfo; idle_gap_ms: number;
  measures: Record<MeasureName, MeasureStatus>; days: DayFacts[]; coverage: Status["coverage"]; warnings: string[]; non_additive: string;
}
const union = (intervals: readonly Bounds[]): number => intervals.length ? reconcileIntervals([intervals])[0] : 0;
const measureSet = (intervals: Record<MeasureName, readonly Attributed[]>, bounds: Bounds): Record<MeasureName, MeasureStatus> => ({
  attested: measure(clip(intervals.attested, bounds)), inferred: measure(clip(intervals.inferred, bounds)), agent: measure(clip(intervals.agent, bounds)),
});
/** Manual attestations that reached the ledger over a minute after the event they record. */
function lateKeys(observations: readonly Observation[]): Set<string> {
  const keys = new Set<string>();
  for (const event of observations) {
    if (event.source !== "manual" || event.receivedAt - event.at <= 60_000) continue;
    if (event.kind === "session-start" || event.kind === "session-stop") keys.add(`${event.session}\u0000${event.kind}\u0000${event.at}`);
  }
  return keys;
}

export function buildReport(store: WorkspanStore, options: ReportOptions = {}): ReportFacts {
  const now = options.now ?? Date.now(), timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const period = options.period ?? "day", idleGapMs = options.idleGapMs ?? 900_000, engine = options.engine ?? engineInfo();
  validateTimezone(timezone);
  const anchor = options.date ?? localDayKey(now, timezone);
  const date = period === "week" ? weekStart(anchor) : anchor;
  const dates = Array.from({ length: period === "week" ? 7 : 1 }, (_, i) => shiftDate(date, i));
  const bounds = dates.map(day => dayBounds(day, timezone));
  const range = { start: bounds[0].start, end: bounds[bounds.length - 1].end };
  const projection = getProjection(store, { idleGapMs, engine, cache: options.cache });
  const observations = store.observations(), rows = store.sessionRows(), transitions = store.sessionTransitions(), notes = store.sessionNotes();
  const annotations = (stretches: Array<{ from: number; to: number | null }>, day: Bounds): Annotation[] => clip(stretches.map(stretch => ({ start: stretch.from, end: stretch.to ?? now, open: stretch.to === null })), day);
  const away = idleStretches(observations), held = inhibitStretches(observations);
  // One index per table: a week report maps hundreds of sessions, and scanning every
  // table once per row per day is quadratic for no reason.
  const transitionsBySession = new Map<string, typeof transitions>();
  for (const transition of transitions) { const list = transitionsBySession.get(transition.sessionId); if (list) list.push(transition); else transitionsBySession.set(transition.sessionId, [transition]); }
  const notesBySession = new Map<string, string[]>();
  for (const note of notes) { const list = notesBySession.get(note.sessionId); if (list) list.push(note.text); else notesBySession.set(note.sessionId, [note.text]); }
  const late = lateKeys(observations);
  const days: DayFacts[] = dates.map((date, i) => {
    const day = bounds[i];
    const intersecting = rows.filter(row => row.startedAt < day.end && (row.endedAt ?? now) > day.start);
    const sessions = intersecting.filter(row => row.removedAt === null).map(row => {
      const rowTransitions = (transitionsBySession.get(row.id) ?? []).filter(t => t.at >= row.startedAt && t.at <= (row.endedAt ?? now));
      const spans = clip(activeSpans(row.startedAt, row.endedAt ?? now, rowTransitions), day);
      const worked = union(spans);
      const wall = clip([{ start: row.startedAt, end: row.endedAt ?? now }], day);
      return {
        session: row.session, project: row.project, root: row.root, state: row.state,
        started_at: row.startedAt, ended_at: row.endedAt, spans,
        worked_ms: row.endedAt === null ? 0 : worked, paused_ms: Math.max(0, union(wall) - worked),
        provisional_ms: row.endedAt === null ? worked : null,
        recorded_later: late.has(`${row.session}\u0000session-start\u0000${row.startedAt}`) || late.has(`${row.session}\u0000session-stop\u0000${row.endedAt}`),
        notes: notesBySession.get(row.id) ?? [],
      };
    });
    const all = Object.values(projection.intervals).flat();
    const span = observedSpan(all, day);
    const collectionEvents = observations.filter(event => event.source === "desktop" && event.at >= day.start && event.at < day.end && /^(sampling-gap|source-unavailable|idle-unavailable):/.test(event.event));
    const counts: Record<string, number> = {};
    let lastAt: number | null = null;
    for (const event of collectionEvents) { const token = event.event.split(":")[0]; counts[token] = (counts[token] ?? 0) + 1; lastAt = Math.max(lastAt ?? 0, event.at); }
    return { date, ...day, measures: measureSet(projection.intervals, day), sessions,
      removed_sessions: intersecting.filter(row => row.removedAt !== null).length,
      uncovered: span ? uncoveredStretches(all, span) : [], away: annotations(away, day), held_awake: annotations(held, day),
      collection: { counts, last_at: lastAt }, events_in_range: observations.filter(event => event.at >= day.start && event.at < day.end).length,
    };
  });
  const warnings: string[] = [];
  if (projection.conflicts) warnings.push("conflicting_evidence");
  if (projection.coverage.open_agent_turns) warnings.push("agent_end_unknown");
  if (projection.coverage.open_sessions) warnings.push("provisional_session");
  if (days.some(day => day.removed_sessions > 0)) warnings.push("removed_sessions");
  for (const name of new Set(days.flatMap(day => Object.keys(day.collection.counts)))) warnings.push(name);
  if (options.delivery?.issues) warnings.push("evidence_delivery_needs_review");
  if (options.delivery?.pending_bytes) warnings.push("evidence_pending");
  return { schema: 1, period, date, timezone, ...range, generated_at: now, revision: store.revision(), engine, idle_gap_ms: idleGapMs,
    watermark: { observations: projection.observations, conflicts: projection.conflicts },
    measures: period === "day" ? days[0].measures : measureSet(projection.intervals, range), days, coverage: projection.coverage, warnings, non_additive: NON_ADDITIVE_NOTE };
}

const LABELS: Record<MeasureName, string> = { attested: "Attested", inferred: "Inferred attended", agent: "Agent runtime" };
/** Whole minutes, and never rounded across the minute boundary: sub-minute time says so. */
export function duration(ms: number): string {
  if (ms > 0 && ms < 60_000) return "<1m";
  const minutes = Math.round(ms / 60_000), hours = Math.floor(minutes / 60), rest = minutes % 60;
  return hours <= 0 ? `${rest}m` : `${hours}h ${String(rest).padStart(2, "0")}m`;
}
const clocks = new Map<string, Intl.DateTimeFormat>();
/** Local wall-clock label; the formatter is cached because a week report renders hundreds of them. */
export function clock(at: number, timezone: string): string {
  let formatter = clocks.get(timezone);
  if (!formatter) { formatter = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false }); clocks.set(timezone, formatter); }
  return formatter.format(new Date(at));
}
function measuresText(measures: Record<MeasureName, MeasureStatus>): string[] {
  return MEASURES.map(name => {
    const value = measures[name];
    const parts = [...value.projects].sort((a,b) => a.project.localeCompare(b.project)).map(row => `${row.project} ${duration(row.ms)}`);
    if (value.unallocated_ms) parts.push(`unallocated ${duration(value.unallocated_ms)}`);
    if (value.ambiguous_ms) parts.push(`ambiguous ${duration(value.ambiguous_ms)}`);
    return `  ${LABELS[name]}: ${duration(value.union_ms)}${parts.length ? ` (${parts.join(", ")})` : ""}`;
  });
}
export function renderText(report: ReportFacts): string {
  const lines: string[] = [];
  if (report.period === "week") lines.push(`Workspan week ${report.date} (${report.timezone})`, "", "Measures for the week (separate, never added together)", "", ...measuresText(report.measures), "");
  for (const day of report.days) {
    lines.push(`Workspan day ${day.date} (${report.timezone})`, "", "Attested sessions", "");
    // A span that reaches the day boundary ends at the next local midnight, which is
    // clearer as 24:00 than as a second 00:00 on the same line.
    const clockOf = (at: number): string => (at === day.end ? "24:00" : clock(at, report.timezone));
    if (!day.sessions.length) lines.push("  none");
    for (const row of day.sessions) {
      const project = row.project ?? "unallocated", late = row.recorded_later ? "  (recorded later)" : "";
      if (row.ended_at === null) lines.push(`  ${clockOf(Math.max(row.started_at, day.start))}-open   ${project}  still running, provisional ${duration(row.provisional_ms ?? 0)}${row.state === "paused" ? " (paused)" : ""}${late}`);
      else {
        const when = row.spans.map(span => `${clockOf(span.start)}-${clockOf(span.end)}`).join(", ");
        lines.push(`  ${when || clockOf(Math.max(row.started_at, day.start))}   ${project}  ${duration(row.worked_ms)}${row.paused_ms ? `  (paused ${duration(row.paused_ms)})` : ""}${late}`);
      }
      for (const note of row.notes) lines.push(`    - ${note}`);
    }
    lines.push("", "Measures for the day (separate, never added together)", "", ...measuresText(day.measures));
    lines.push("", "Not counted (no measure covers this stretch)", "");
    if (!day.uncovered.length) lines.push("  none");
    for (const stretch of day.uncovered) lines.push(`  ${clockOf(stretch.start)}-${clockOf(stretch.end)}   ${duration(stretch.end - stretch.start)}`);
    if (day.uncovered.length) lines.push("  attest one with: workspan session start --at HH:MM");
    for (const [title, stretches, missing] of [["Away (seat idle annotations, never subtracted)", day.away, "resume"], ["Held awake (idle inhibit annotations, never subtracted)", day.held_awake, "clear"]] as const) {
      lines.push("", title, "");
      if (!stretches.length) lines.push("  none");
      for (const stretch of stretches) lines.push(`  ${clockOf(stretch.start)}-${stretch.open ? "open" : clockOf(stretch.end)}   ${duration(stretch.end - stretch.start)}${stretch.open ? ` (no ${missing} recorded)` : ""}`);
    }
    lines.push("", "Collection (desktop lane health)", "");
    const counts = Object.entries(day.collection.counts).sort().map(([name, count]) => `${count} ${name}`);
    lines.push(counts.length ? `  ${counts.join(", ")} (last ${clockOf(day.collection.last_at!)})` : "  none");
    const removals = day.removed_sessions ? `, ${day.removed_sessions} removed session(s) (corrected)` : "";
    lines.push("", `Engine: Bend via ${report.engine.label}. Coverage: ${report.coverage.events} events, ${report.coverage.conflicts} conflict(s)${report.coverage.conflicts ? " need review" : ""}${removals}.`);
    if (report.coverage.open_agent_turns) lines.push(`Open agent turns: ${report.coverage.open_agent_turns} (end unknown, not finalized).`);
    lines.push("");
  }
  if (report.warnings.length) lines.push(`Review: ${report.warnings.join(", ")}`);
  return lines.join("\n").trimEnd();
}

/** One typed row set drives both tabular formats; exact ms, never parsed rounded text. */
export function reportRows(report: ReportFacts): Array<Array<string | number>> {
  const rows: Array<Array<string | number>> = [];
  const add = (scope: string, date: string, bounds: Bounds, measures: Record<MeasureName, MeasureStatus>) => {
    for (const name of MEASURES) {
      const value = measures[name];
      rows.push([scope, date, report.timezone, bounds.start, bounds.end, name, "union", "", value.union_ms, "finalized", report.revision, report.engine.digest ?? "unknown", report.coverage.conflicts, report.coverage.open_agent_turns, report.coverage.open_sessions]);
      for (const row of value.projects) rows.push([scope, date, report.timezone, bounds.start, bounds.end, name, "project", row.project, row.ms, "finalized", report.revision, report.engine.digest ?? "unknown", report.coverage.conflicts, report.coverage.open_agent_turns, report.coverage.open_sessions]);
      for (const [kind, ms] of [["unallocated", value.unallocated_ms], ["ambiguous", value.ambiguous_ms]] as const) if (ms) rows.push([scope, date, report.timezone, bounds.start, bounds.end, name, kind, "", ms, "review", report.revision, report.engine.digest ?? "unknown", report.coverage.conflicts, report.coverage.open_agent_turns, report.coverage.open_sessions]);
    }
  };
  if (report.period === "week") add("week", report.date, report, report.measures);
  for (const day of report.days) {
    add("day", day.date, day, day.measures);
    for (const row of day.sessions) if (row.provisional_ms !== null) rows.push(["day", day.date, report.timezone, day.start, day.end, "attested", "provisional_session", row.project ?? "", row.provisional_ms, "provisional", report.revision, report.engine.digest ?? "unknown", report.coverage.conflicts, report.coverage.open_agent_turns, report.coverage.open_sessions]);
  }
  return rows.map(row => [...row, report.generated_at, report.idle_gap_ms, report.engine.version ?? "unknown", report.watermark.observations, report.watermark.conflicts, report.warnings.join("; ")]);
}
const HEADERS = ["scope", "date", "timezone", "start_ms", "end_ms", "measure", "kind", "project", "ms", "state", "revision", "policy_digest", "conflicts", "open_agent_turns", "open_sessions", "generated_at_ms", "idle_gap_ms", "policy_version", "watermark_observations", "watermark_conflicts", "warnings"];
export function renderCsv(report: ReportFacts): string {
  const cell = (value: string | number): string => {
    let text = String(value);
    if (typeof value === "string" && /^[\s]*[=+@-]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  return [HEADERS, ...reportRows(report)].map(row => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
export function renderMarkdown(report: ReportFacts): string {
  const cell = (value: string | number): string => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "&#124;").replace(/[\r\n]/g, " ").replace(/`/g, "&#96;").replace(/\[/g, "&#91;").replace(/\]/g, "&#93;");
  return [`# Workspan ${report.period} ${report.date}`, "", report.non_additive, "", "| " + HEADERS.join(" | ") + " |", "| " + HEADERS.map(() => "---").join(" | ") + " |", ...reportRows(report).map(row => "| " + row.map(cell).join(" | ") + " |"), "", "Provisional rows are not finalized hours. Union, project and provisional rows are not additive. Coverage warnings remain in every row.", ""].join("\n");
}
export function formatReport(report: ReportFacts, format: "text" | "json" | "csv" | "md"): string {
  if (format === "json") return JSON.stringify(report, null, 2);
  if (format === "csv") return renderCsv(report);
  if (format === "md") return renderMarkdown(report);
  return renderText(report);
}
