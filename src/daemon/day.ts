/**
 * The day report: the human-shaped log for outside-harness work. Attested
 * sessions with their notes and excluded pauses, the inferred and agent measures
 * for the day by project, unallocated and ambiguous time, conflicts - and never
 * a sum of the three measures.
 *
 * The renderer lives in the daemon, which owns the store; the CLI only prints
 * the text it gets back. Totals stay Bend's: every measure total below is a
 * reconcileIntervals union, never a JavaScript sum.
 */
import { localDayKey } from "../core/ledger.ts";
import { reconcileIntervals } from "../core/native.ts";
import { activeSpans, agentIntervals, idleStretches, partitionByProject } from "../daemon/measures.ts";
import type { WorkspanStore, Observation, SessionRow, SessionNote } from "../daemon/db.ts";

export interface DayOptions { date?: string; timezone?: string; now?: number }
export interface DayReport { date: string; timezone: string; text: string }

const HOUR = 3_600_000;

/** Minute-exact local-midnight bounds for a date, found by stepping localDayKey. */
export function dayBounds(date: string, timezone: string): { start: number; end: number } {
  const anchor = Date.parse(`${date}T00:00:00Z`) - 14 * HOUR;
  let start = anchor;
  while (localDayKey(start, timezone) !== date && start < anchor + 48 * HOUR) start += HOUR;
  if (localDayKey(start, timezone) !== date) throw new Error(`no such local day: ${date}`);
  let next = start + HOUR;
  while (localDayKey(next, timezone) === date) next += HOUR;
  // `next` is past midnight by up to an hour: bisect back to the minute.
  let low = next - HOUR;
  let high = next;
  while (high - low > 60_000) {
    const mid = low + Math.floor((high - low) / 2);
    if (localDayKey(mid, timezone) === date) low = mid; else high = mid;
  }
  return { start, end: high };
}

/** Clip intervals to the day; the union and attribution stay untouched. */
function clip(intervals: ReadonlyArray<{ start: number; end: number }>, bounds: { start: number; end: number }): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (const interval of intervals) {
    const start = Math.max(interval.start, bounds.start);
    const end = Math.min(interval.end, bounds.end);
    if (end > start) out.push({ start, end });
  }
  return out;
}

const duration = (ms: number): string => {
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours <= 0 ? `${rest}m` : `${hours}h ${rest < 10 ? `0${rest}` : rest}m`;
};

/**
 * Whether a session's own start or stop was written down much later than it states.
 * That gap is the correction: the event time is the person's claim, the receipt time
 * is when they made it, and neither is rewritten to match the other.
 */
function recordedLate(observations: readonly Observation[], row: SessionRow): boolean {
  const late = (kind: "session-start" | "session-stop", when: number): boolean => observations.some(event =>
    event.source === "manual" && event.kind === kind && event.session === row.session && event.at === when && event.receivedAt - event.at > 60_000);
  return late("session-start", row.startedAt) || (row.endedAt !== null && late("session-stop", row.endedAt));
}

const clock = (at: number, timezone: string): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(at));

export function renderDay(store: WorkspanStore, options: DayOptions = {}): DayReport {
  const timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = options.date ?? localDayKey(options.now ?? Date.now(), timezone);
  const bounds = dayBounds(date, timezone);
  const now = options.now ?? Date.now();
  const sessions = store.sessionRows();
  const transitions = store.sessionTransitions();
  const notes = store.sessionNotes();
  const observations = store.observations();

  const lines: string[] = [`Workspan day ${date} (${timezone})`, ""];

  lines.push("Attested sessions", "");
  const inDay = sessions.filter(row => localDayKey(row.startedAt, timezone) === date || localDayKey(row.endedAt ?? row.startedAt, timezone) === date);
  const daySessions = inDay.filter(row => row.removedAt === null);
  const removedToday = inDay.filter(row => row.removedAt !== null);
  if (!daySessions.length && !removedToday.length) lines.push("  none");
  for (const row of daySessions) {
    const project = row.project ?? "unallocated";
    const rowTransitions = transitions.filter(t => t.sessionId === row.id && t.at >= row.startedAt);
    // A session stated after the fact is still the person's evidence, and the report
    // says so: the ledger keeps what was stated and when it was recorded.
    const late = recordedLate(observations, row) ? "  (recorded later)" : "";
    if (row.endedAt === null) {
      lines.push(`  ${clock(row.startedAt, timezone)}-open   ${project}  still running, provisional ${duration(Math.max(0, now - row.startedAt))}${late}`);
    } else {
      const spans = clip(activeSpans(row.startedAt, row.endedAt, rowTransitions), bounds);
      const worked = spans.reduce((sum, span) => sum + (span.end - span.start), 0);
      const when = spans.length === 1
        ? `${clock(spans[0].start, timezone)}-${clock(spans[0].end, timezone)}`
        : spans.map(span => `${clock(span.start, timezone)}-${clock(span.end, timezone)}`).join(", ");
      const paused = (row.endedAt - row.startedAt) - activeSpans(row.startedAt, row.endedAt, rowTransitions).reduce((sum, span) => sum + (span.end - span.start), 0);
      lines.push(`  ${when || clock(row.startedAt, timezone)}   ${project}  ${duration(worked)}${paused > 0 ? `  (paused ${duration(paused)})` : ""}${late}`);
    }
    for (const note of notes.filter(n => n.sessionId === row.id)) lines.push(`    - ${note.text}`);
  }

  lines.push("", "Measures for the day (separate, never added together)", "");
  const windows = store.windows().filter(w => w.kind === "work");
  const measureData = {
    attested: daySessions.flatMap(row => {
      const rowTransitions = transitions.filter(t => t.sessionId === row.id && t.at >= row.startedAt);
      const source = row.endedAt !== null ? activeSpans(row.startedAt, row.endedAt, rowTransitions) : [];
      return clip(source, bounds).map(span => ({ start: span.start, end: span.end, project: row.project ?? undefined }));
    }),
    inferred: clip(windows.map(w => ({ start: w.start, end: w.end })), bounds).map(span => {
      const window = windows.find(w => w.start <= span.start && w.end >= span.end && w.client !== "unallocated");
      return { ...span, project: window?.client };
    }),
    agent: clip(agentIntervals(observations).intervals.map(({ start, end }) => ({ start, end })), bounds),
  } as const;
  for (const [name, label] of [["attested", "Attested"], ["inferred", "Inferred attended"], ["agent", "Agent runtime"]] as const) {
    const intervals = measureData[name] as ReadonlyArray<{ start: number; end: number; project?: string }>;
    const union = intervals.length ? reconcileIntervals([intervals], {})[0] : 0;
    const part = partitionByProject(intervals);
    const parts = [...part.projects.entries()].sort().map(([project, ms]) => `${project} ${duration(ms)}`);
    if (part.unallocated > 0) parts.push(`unallocated ${duration(part.unallocated)}`);
    if (part.ambiguous > 0) parts.push(`ambiguous ${duration(part.ambiguous)}`);
    lines.push(`  ${label}: ${duration(union)}${parts.length ? ` (${parts.join(", ")})` : ""}`);
  }

  // Seat idle is an annotation, not a measure: it is listed for review and never
  // subtracted, because "no seat input" is not the same as "not working".
  const away = idleStretches(observations)
    .map(stretch => ({ start: stretch.from, end: stretch.to ?? now, open: stretch.to === null }))
    .map(stretch => ({ ...stretch, start: Math.max(stretch.start, bounds.start), end: Math.min(stretch.end, bounds.end) }))
    .filter(stretch => stretch.end > stretch.start);
  lines.push("", "Away (seat idle annotations, never subtracted)", "");
  if (!away.length) lines.push("  none");
  for (const stretch of away) {
    const when = `${clock(stretch.start, timezone)}-${stretch.open ? "open" : clock(stretch.end, timezone)}`;
    // A short stretch is real but not a minute long; "0m" would read as nothing.
    const held = stretch.end - stretch.start;
    const heldText = held < 60_000 ? "<1m" : duration(held);
    // A missing resume is not an end: say so instead of inventing the return.
    lines.push(`  ${when}   ${heldText}${stretch.open ? " (no resume recorded)" : ""}`);
  }

  const conflicts = store.conflictRows().length;
  const removals = removedToday.length > 0 ? `, ${removedToday.length} removed session(s) (corrected)` : "";
  lines.push("", `Engine: Bend via the generated policy. Coverage: ${observations.length} events, ${conflicts} conflict(s)${conflicts > 0 ? " need review" : ""}${removals}.`);
  return { date, timezone, text: lines.join("\n") };
}
