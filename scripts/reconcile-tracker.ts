#!/usr/bin/env bun
/** Read-only, exact reconciliation. Source and target unions both come from Bend. */
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { WorkspanClient } from "../src/client.ts";
import { reconcileIntervals } from "../src/core/native.ts";
import { calendarDate, clip, dayBounds, shiftDate, type Bounds } from "../src/daemon/calendar.ts";
import { localDayKey } from "../src/core/ledger.ts";
import type { ReportFacts } from "../src/daemon/report.ts";
export interface TrackerWindow { start: number; end: number; kind: string }
export function trackerDayMs(windows: readonly TrackerWindow[], bounds: Bounds): number {
  const intervals = clip(windows.filter(window => window.kind === "work"), bounds);
  return intervals.length ? reconcileIntervals([intervals])[0] : 0;
}
function trackerWindows(path: string): TrackerWindow[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return (db.prepare("select start, end, kind from windows").all() as Array<Record<string, unknown>>).map(row => ({ start: Number(row.start), end: Number(row.end), kind: String(row.kind) })); }
  finally { db.close(); }
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => { const at = args.indexOf(name); return at === -1 ? undefined : args[at + 1]; };
  const days = Number(flag("--days") ?? 3);
  if (!Number.isSafeInteger(days) || days < 1 || days > 366) throw new Error("--days must be 1-366");
  const timezone = flag("--tz") ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const trackerPath = flag("--tracker") ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "pi-time-tracker", "tracker.sqlite");
  // Name the file that could not be read: the raw SQLite message does not.
  let windows: TrackerWindow[];
  try { windows = trackerWindows(trackerPath); }
  catch (error) { throw new Error(`cannot read ${trackerPath}: ${error instanceof Error ? error.message : String(error)}`); }
  const client = new WorkspanClient({ socketPath: flag("--socket") });
  const anchor = flag("--date") ?? localDayKey(Date.now(), timezone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) throw new Error("--date must be YYYY-MM-DD");
  calendarDate(anchor);
  console.log(`Tracker ledger: ${trackerPath} (${windows.length} windows)`);
  console.log(`Workspan socket: ${client.socketPath}`);
  console.log(`Days: ${days}, timezone: ${timezone}; all values and deltas are exact milliseconds`);
  console.log("day         tracker work  ws inferred   ws attested   ws agent      delta ms");
  let unavailable = false;
  for (let offset = 0; offset < days; offset++) {
    const date = shiftDate(anchor, -offset), bounds = dayBounds(date, timezone);
    const source = trackerDayMs(windows, bounds);
    try {
      const report = JSON.parse(await client.report({ period: "day", date, timezone, format: "json" })) as ReportFacts;
      if (report.start !== bounds.start || report.end !== bounds.end || report.timezone !== timezone) throw new Error("report range does not match source range");
      console.log([date.padEnd(12), String(source).padEnd(14), String(report.measures.inferred.union_ms).padEnd(14), String(report.measures.attested.union_ms).padEnd(14), String(report.measures.agent.union_ms).padEnd(14), report.measures.inferred.union_ms - source].join(""));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // A target that answered with different bounds is a mismatch to fix, not an
      // availability problem, and it must never be smoothed into "unavailable".
      if (reason.includes("report range does not match source range")) throw new Error(`${date}: ${reason}`);
      unavailable = true;
      console.log(`${date}  ${source}  unavailable (not zero): ${reason}`);
    }
  }
  console.log("Attested, inferred and agent runtime are separate measures, never added together.");
  if (unavailable) throw new Error("reconciliation incomplete: target report unavailable");
}
if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : "reconciliation failed"); process.exitCode = 1; });
