import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspanStore } from "../src/daemon/db.ts";
import { validateEvent } from "../src/daemon/evidence.ts";
import { dayBounds, renderDay } from "../src/daemon/day.ts";

const roots: string[] = [];
const tz = "UTC";
const t0 = Date.parse("2026-10-03T09:00:00Z");
const event = (kind: string, at: number, session = "s1", project = "coral-stuff") =>
  validateEvent({ v: 1, source: "manual", instance: "cli", session, event: `${kind}-${at}`, kind, at, origin: "attested", project });

function store(): WorkspanStore {
  const root = mkdtempSync(join(tmpdir(), "workspan-day-"));
  roots.push(root);
  return new WorkspanStore(join(root, "workspan.sqlite"));
}

test("day bounds are minute-exact local midnight in the zone", () => {
  const utc = dayBounds("2026-10-03", "UTC");
  expect(utc.start).toBe(Date.parse("2026-10-03T00:00:00Z"));
  expect(utc.end).toBe(Date.parse("2026-10-04T00:00:00Z"));
  // Pacific day-light time is UTC-7 on this date: the local day starts 7h late.
  const pacific = dayBounds("2026-10-03", "America/Los_Angeles");
  expect(pacific.start).toBe(Date.parse("2026-10-03T07:00:00Z"));
});

test("a day renders sessions, excluded pauses, notes and separate measures", () => {
  const s = store();
  try {
    s.ingest(event("session-start", t0), 1);
    s.ingest(event("session-pause", t0 + 60 * 60_000), 1);
    s.ingest(event("session-resume", t0 + 90 * 60_000), 1);
    s.ingest(event("session-stop", t0 + 150 * 60_000), 1);
    const row = s.sessionRows()[0];
    s.addSessionNote(row.id, "provider auth plus report fix", t0 + 10 * 60_000);

    const report = renderDay(s, { date: "2026-10-03", timezone: tz, now: t0 + 160 * 60_000 });
    expect(report.text).toContain("Workspan day 2026-10-03 (UTC)");
    // Two spans: 09:00-10:00 and 11:30-12:30, with the pause excluded and named.
    expect(report.text).toContain("09:00-10:00, 10:30-11:30   coral-stuff  2h 00m  (paused 30m)");
    expect(report.text).toContain("- provider auth plus report fix");
    // Attested for the day excludes the pause: 120 minutes, not 150.
    expect(report.text).toMatch(/Attested: 2h 00m \(coral-stuff 2h 00m\)/);
    expect(report.text).toContain("Measures for the day (separate, never added together)");
    expect(report.text).toContain("Inferred attended: 0m");
    expect(report.text).toContain("Agent runtime: 0m");
    expect(report.text).not.toMatch(/total|sum/i);
  } finally { s.close(); }
});

test("an open session renders as provisional and still counts no final hours", () => {
  const s = store();
  try {
    s.ingest(event("session-start", t0, "open"), 1);
    const report = renderDay(s, { date: "2026-10-03", timezone: tz, now: t0 + 25 * 60_000 });
    expect(report.text).toContain("09:00-open   coral-stuff  still running, provisional 25m");
    expect(report.text).toMatch(/Attested: 0m/);
  } finally { s.close(); }
});

test("a session crossing midnight is clipped to the day it is reported in", () => {
  const s = store();
  try {
    const late = Date.parse("2026-10-03T23:00:00Z");
    s.ingest(event("session-start", late, "night"), 1);
    s.ingest(event("session-stop", late + 3 * 60 * 60_000, "night"), 1);
    const third = renderDay(s, { date: "2026-10-03", timezone: tz, now: late + 240 * 60_000 });
    expect(third.text).toContain("23:00-00:00");
    expect(third.text).toMatch(/Attested: 1h 00m/);
    const fourth = renderDay(s, { date: "2026-10-04", timezone: tz, now: late + 240 * 60_000 });
    expect(fourth.text).toContain("00:00-02:00");
    expect(fourth.text).toMatch(/Attested: 2h 00m/);
  } finally { s.close(); }
});

