#!/usr/bin/env bun
/**
 * Cutover reconciliation: the tracker's recorded work per day, beside Workspan's
 * measures for the same day.
 *
 * Read-only on both sides. The tracker's ledger is opened with `readOnly: true`; the
 * Workspan numbers come from the daemon's own day report, because a client must not
 * open the accounting database. The comparable pair is the tracker's `work` windows and
 * Workspan's **inferred attended** measure - both are interaction-derived windows with
 * the same idle-gap semantics. Attested sessions and agent runtime are printed
 * separately because they are different measures, never because they should be added.
 *
 * Usage: bun scripts/reconcile-tracker.ts [--days N] [--tz ZONE] [--tracker path] [--socket path]
 */
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { WorkspanClient } from "../src/client.ts";
import { sweep, totalOf } from "../src/daemon/measures.ts";
import { dayBounds } from "../src/daemon/day.ts";
import { localDayKey } from "../src/core/ledger.ts";

const args = process.argv.slice(2);
const flagValue = (name: string): string | undefined => { const at = args.indexOf(name); return at === -1 ? undefined : args[at + 1]; };
const days = Number(flagValue("--days") ?? 3);
const timezone = flagValue("--tz") ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
const trackerPath = flagValue("--tracker") ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "pi-time-tracker", "tracker.sqlite");

interface TrackerWindow { start: number; end: number; kind: string }

function trackerWindows(path: string): TrackerWindow[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare("select start, end, kind from windows").all() as Array<Record<string, unknown>>)
      .map(row => ({ start: Number(row.start), end: Number(row.end), kind: String(row.kind) }));
  } finally { db.close(); }
}

const minutes = (ms: number): string => `${Math.round(ms / 60_000)}m`;

/** `Attested: 1h 05m (coral 1h 05m)` -> milliseconds, from the daemon's own report. */
function measureFromReport(text: string, label: string): number | null {
  const line = text.split("\n").find(row => row.trimStart().startsWith(`${label}:`));
  if (!line) return null;
  const value = line.slice(line.indexOf(":") + 1).trim();
  const hours = /(\d+)h/.exec(value);
  const mins = /(\d+)m/.exec(value);
  if (!hours && !mins) return null;
  return Number(hours?.[1] ?? 0) * 3_600_000 + Number(mins?.[1] ?? 0) * 60_000;
}

const now = Date.now();
let windows: TrackerWindow[];
try { windows = trackerWindows(trackerPath); }
catch (error) {
  console.error(`cannot read ${trackerPath}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const socketPath = flagValue("--socket");
const client = new WorkspanClient({ ...(socketPath ? { socketPath } : {}) });

console.log(`Tracker ledger: ${trackerPath} (${windows.length} windows)`);
console.log(`Workspan socket: ${client.socketPath}`);
console.log(`Days: ${days}, timezone: ${timezone}`);
console.log("");
console.log(["day".padEnd(12), "tracker work".padEnd(14), "ws inferred".padEnd(13), "ws attested".padEnd(13), "ws agent".padEnd(10), "inferred - tracker"].join(""));

for (let offset = 0; offset < days; offset += 1) {
  const date = localDayKey(now - offset * 86_400_000, timezone);
  const bounds = dayBounds(date, timezone);
  const inDay = windows.filter(window => window.kind === "work" && window.end > bounds.start && window.start < bounds.end);
  const trackerMs = totalOf(sweep(inDay.map(window => ({ start: window.start, end: window.end }))));
  let inferred: number | null = null;
  let attested: number | null = null;
  let agent: number | null = null;
  try {
    const report = (await client.day({ date, timezone })) as { text: string };
    inferred = measureFromReport(report.text, "Inferred attended");
    attested = measureFromReport(report.text, "Attested");
    agent = measureFromReport(report.text, "Agent runtime");
  } catch (error) {
    console.error(`workspan day ${date}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const cell = (ms: number | null): string => (ms === null ? "?" : minutes(ms));
  console.log([
    date.padEnd(12),
    minutes(trackerMs).padEnd(14),
    cell(inferred).padEnd(13),
    cell(attested).padEnd(13),
    cell(agent).padEnd(10),
    inferred === null ? "?" : minutes(inferred - trackerMs),
  ].join(""));
}

console.log("");
console.log("The tracker's `work` windows and Workspan's inferred measure are both interaction-derived,");
console.log("so they are the comparable pair. Attested sessions and agent runtime are separate measures:");
console.log("read them beside the pair, never added to it.");
