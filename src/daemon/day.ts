/** Compatibility surface: the daemon builds facts once, renderers never account. */
import type { WorkspanStore } from "./db.ts";
import { buildReport, renderText } from "./report.ts";
export { dayBounds } from "./calendar.ts";
export interface DayOptions { date?: string; timezone?: string; now?: number }
export interface DayReport { date: string; timezone: string; text: string }
export function renderDay(store: WorkspanStore, options: DayOptions = {}): DayReport {
  const facts = buildReport(store, { ...options, period: "day" });
  return { date: facts.date, timezone: facts.timezone, text: renderText(facts) };
}
