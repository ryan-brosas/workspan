import { localDayKey } from "../core/ledger.ts";

export class CalendarError extends Error {
  constructor(message: string) { super(message); this.name = "CalendarError"; }
}
export interface Bounds { start: number; end: number }
export function validateTimezone(timezone: string): void {
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); } catch { throw new CalendarError("timezone must be a valid IANA zone"); }
}
const DAY = 86_400_000;
export function calendarDate(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new CalendarError("date must be YYYY-MM-DD");
  const value = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(value) || new Date(value).toISOString().slice(0, 10) !== date) throw new CalendarError("no such calendar date");
  return value;
}
/**
 * The calendar key `days` after `date`. Outside years 0000-9999 `toISOString()` switches
 * to an extended-year form, and past the ECMAScript range it throws: neither is a
 * calendar key, so both are refused here instead of leaking a malformed date.
 */
export function shiftDate(date: string, days: number): string {
  const shifted = new Date(calendarDate(date) + days * DAY);
  const key = Number.isFinite(shifted.getTime()) ? shifted.toISOString().slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new CalendarError(`date out of calendar range: ${date} shifted by ${days} day(s)`);
  return key;
}
export function weekStart(date: string): string { const day = new Date(calendarDate(date)).getUTCDay(); return shiftDate(date, -((day + 6) % 7)); }

/** Find both transitions exactly, not the first hourly sample inside the day. */
export function dayBounds(date: string, timezone: string): Bounds {
  const anchor = calendarDate(date);
  // Validate the IANA zone even for a skipped date.
  validateTimezone(timezone);
  // The search assumes local keys are ordered and four digits wide. Within a day of the
  // key format's extremes that assumption fails (a five-digit year sorts before any
  // four-digit one), so those dates are refused rather than answered wrongly.
  if (date < "0001-01-02" || date > "9999-12-30") throw new CalendarError("date is outside the supported calendar range");
  const lowerBound = (after: boolean): number => {
    let low = anchor - 2 * DAY, high = anchor + 2 * DAY;
    while (high - low > 1) {
      const mid = low + Math.floor((high - low) / 2);
      const key = localDayKey(mid, timezone);
      if (key < date || (after && key === date)) low = mid; else high = mid;
    }
    return high;
  };
  const start = lowerBound(false), end = lowerBound(true);
  if (start === end || localDayKey(start, timezone) !== date) throw new CalendarError("no such local day in this timezone");
  // State the bracket invariant the search depends on instead of assuming it: both
  // bounds are found only if each stayed on its own side of the target day.
  if (!(localDayKey(start - 1, timezone) < date && localDayKey(end, timezone) > date)) throw new CalendarError("no such local day in this timezone");
  return { start, end };
}

export function clip<T extends Bounds>(intervals: readonly T[], bounds: Bounds): T[] {
  return intervals.map(interval => ({ ...interval, start: Math.max(interval.start, bounds.start), end: Math.min(interval.end, bounds.end) })).filter(interval => interval.end > interval.start);
}
