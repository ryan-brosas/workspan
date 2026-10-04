import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspanStore, type Observation } from "../src/daemon/db.ts";
import { validateEvent, type EvidenceEvent } from "../src/daemon/evidence.ts";
import { inhibitStretches } from "../src/daemon/measures.ts";
import { renderDay } from "../src/daemon/day.ts";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const tz = "UTC";
const t0 = Date.parse("2026-10-03T09:00:00Z");
const HOUR = 3_600_000;
/** What the collector writes: a seat annotation, unknown origin, no project. */
const desktop = (what: string, at: number) => validateEvent({ v: 1, source: "desktop", instance: "omarchy-desktop", session: "omarchy-desktop", event: `${what}:${at}`, kind: "interaction", at, origin: "unknown" });
const session = (kind: string, at: number) => validateEvent({ v: 1, source: "manual", instance: "cli", session: "s1", event: `${kind}-${at}`, kind, at, origin: "attested", project: "coral" });
const observed = (event: EvidenceEvent): Observation => ({ ...event, eventId: `${event.source}\u0000${event.session}\u0000${event.event}`, receivedAt: event.at });

function store(): WorkspanStore {
  const root = mkdtempSync(join(tmpdir(), "workspan-inhibit-"));
  roots.push(root);
  return new WorkspanStore(join(root, "workspan.sqlite"));
}

/** The measures block alone, so a test can prove the annotations added nothing to it. */
const measuresOf = (text: string): string => text.slice(text.indexOf("Measures for the day"), text.indexOf("Not counted"));

test("held-awake stretches come from the annotations, and a missing clear stays open", () => {
  expect(inhibitStretches([observed(desktop("inhibit-idle", t0)), observed(desktop("inhibit-cleared", t0 + HOUR))]))
    .toEqual([{ from: t0, to: t0 + HOUR }]);
  expect(inhibitStretches([observed(desktop("inhibit-idle", t0))])).toEqual([{ from: t0, to: null }]);
  expect(inhibitStretches([observed(desktop("inhibit-cleared", t0))])).toEqual([]);
  expect(inhibitStretches([observed(desktop("inhibit-idle", t0 + 60_000)), observed(desktop("inhibit-idle", t0))]))
    .toEqual([{ from: t0, to: null }]);
  // A stretch is never half a minute long and never negative: a clear before the hold
  // closes nothing.
  expect(inhibitStretches([observed(desktop("inhibit-idle", t0)), observed(desktop("inhibit-cleared", t0 - 1))]))
    .toEqual([]);
});

test("the day lists held awake and collection health without moving a measure", () => {
  const ledger = store();
  ledger.ingest(session("session-start", t0), 1);
  ledger.ingest(session("session-stop", t0 + HOUR), 1);
  const date = "2026-10-03";
  const before = renderDay(ledger, { date, timezone: tz, now: t0 + 6 * HOUR }).text;
  expect(before).toContain("Held awake (idle inhibit annotations, never subtracted)");
  expect(measuresOf(before)).toBeTruthy();

  ledger.ingest(desktop("inhibit-idle", t0 + HOUR), 1);
  ledger.ingest(desktop("inhibit-cleared", t0 + 2 * HOUR), 1);
  ledger.ingest(desktop("sampling-gap", t0 + 3 * HOUR), 1);
  const after = renderDay(ledger, { date, timezone: tz, now: t0 + 6 * HOUR }).text;

  expect(after).toContain("10:00-11:00   1h 00m");
  expect(after).toContain("1 sampling-gap (last 12:00)");
  // The proof: every measure total is byte-for-byte what it was without the annotations.
  expect(measuresOf(after)).toBe(measuresOf(before));
  expect(after).toMatch(/Collection \(desktop lane health\)/);
});
