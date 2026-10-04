import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspanStore } from "../src/daemon/db.ts";
import { validateEvent } from "../src/daemon/evidence.ts";
import { dayBounds, renderDay } from "../src/daemon/day.ts";
import { buildStatus } from "../src/daemon/measures.ts";

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
    // A span clipped to the day boundary ends at the next local midnight, named 24:00
    // so it cannot be misread as ending where the day starts.
    expect(third.text).toContain("23:00-24:00");
    expect(third.text).toMatch(/Attested: 1h 00m/);
    const fourth = renderDay(s, { date: "2026-10-04", timezone: tz, now: late + 240 * 60_000 });
    expect(fourth.text).toContain("00:00-02:00");
    expect(fourth.text).toMatch(/Attested: 2h 00m/);
  } finally { s.close(); }
});

test("fractional offsets and DST resolve exact local calendar boundaries", () => {
  expect(dayBounds("2026-10-03", "Asia/Kathmandu").start).toBe(Date.parse("2026-10-02T18:15:00Z"));
  expect(dayBounds("2026-10-03", "Asia/Kathmandu").end).toBe(Date.parse("2026-10-03T18:15:00Z"));
  const spring = dayBounds("2026-03-08", "America/New_York");
  const autumn = dayBounds("2026-11-01", "America/New_York");
  expect(spring.end - spring.start).toBe(23 * 3_600_000);
  expect(autumn.end - autumn.start).toBe(25 * 3_600_000);
  expect(() => dayBounds("2026-02-30", "UTC")).toThrow();
});

test("a middle day of a long session contains its attested time", () => {
  const s = store();
  try {
    const from = Date.parse("2026-10-01T09:00:00Z");
    s.ingest(event("session-start", from, "long"), from);
    s.ingest(event("session-stop", from + 4 * 86_400_000, "long"), from);
    // A pinned now, so the middle day numbers cannot depend on when the suite runs.
    expect(renderDay(s, { date: "2026-10-03", timezone: tz, now: from + 3 * 86_400_000 }).text).toContain("Attested: 24h 00m");
  } finally { s.close(); }
});

test("clipping keeps agent attribution and inferred ambiguity from the shared projection", () => {
  const s = store();
  try {
    s.ingest(validateEvent({ source: "pi", instance: "i", session: "a", event: "start", kind: "agent-start", at: t0, origin: "automated", project: "client-b", root: "/b" }), t0);
    s.ingest(validateEvent({ source: "pi", instance: "i", session: "a", event: "end", kind: "agent-end", at: t0 + 3_600_000, origin: "automated", project: "client-b", root: "/b" }), t0);
    s.save({ id: "wa", root: "/a", client: "client-a", sessionId: "a", task: "a", start: t0, end: t0 + 7_200_000, kind: "work" });
    s.save({ id: "wb", root: "/b", client: "client-b", sessionId: "b", task: "b", start: t0 + 1_800_000, end: t0 + 5_400_000, kind: "work" });
    const report = renderDay(s, { date: "2026-10-03", timezone: tz, now: t0 + 8 * 3_600_000 });
    expect(report.text).toContain("Agent runtime: 1h 00m (client-b 1h 00m)");
    expect(report.text).toContain("Inferred attended: 2h 00m (client-a 1h 00m, ambiguous 1h 00m)");
    expect(buildStatus(s, { idleGapMs: 900_000 }).measures.inferred.ambiguous_ms).toBe(3_600_000);
  } finally { s.close(); }
});
