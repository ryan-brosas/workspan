import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localDayKey } from "../src/core/ledger.ts";
import { WorkspanStore } from "../src/daemon/db.ts";
import { dayBounds, renderDay } from "../src/daemon/day.ts";
import { validateEvent } from "../src/daemon/evidence.ts";
import { buildStatus, observedSpan, uncoveredStretches } from "../src/daemon/measures.ts";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const HOUR = 3_600_000;
const t0 = Date.parse("2026-10-03T09:00:00Z");
const session = (kind: string, at: number, id = "s1") => validateEvent({ v: 1, source: "manual", instance: "cli", session: id, event: `${kind}-${at}-${id}`, kind, at, origin: "attested", project: "coral" });

test("the review list is the complement of the measures inside the observed span", () => {
  expect(uncoveredStretches([{ start: 0, end: 1_000 }, { start: 2_000, end: 3_000 }], { start: 0, end: 4_000 }))
    .toEqual([{ start: 1_000, end: 2_000 }, { start: 3_000, end: 4_000 }]);
  // Overlapping intervals merge, so nothing is reported inside covered time.
  expect(uncoveredStretches([{ start: 0, end: 1_500 }, { start: 1_000, end: 3_000 }], { start: 500, end: 2_500 })).toEqual([]);
  expect(uncoveredStretches([{ start: 1_000, end: 2_000 }], { start: 0, end: 3_000 }))
    .toEqual([{ start: 0, end: 1_000 }, { start: 2_000, end: 3_000 }]);
  expect(uncoveredStretches([], { start: 0, end: 1_000 })).toEqual([{ start: 0, end: 1_000 }]);
});

test("a day with no intervals has no span, so nothing is called uncovered", () => {
  expect(observedSpan([], { start: 0, end: 1_000 })).toBeNull();
  expect(observedSpan([{ start: 10_000, end: 11_000 }], { start: 0, end: 1_000 })).toBeNull();
  expect(observedSpan([{ start: 0, end: 500 }, { start: 800, end: 1_600 }], { start: 0, end: 1_000 }))
    .toEqual({ start: 0, end: 1_000 });
});

test("a gap between two sessions is reported, and it moves no measure", () => {
  const root = mkdtempSync(join(tmpdir(), "workspan-uncovered-"));
  roots.push(root);
  const store = new WorkspanStore(join(root, "workspan.sqlite"));
  try {
    store.ingest(session("session-start", t0), 1);
    store.ingest(session("session-stop", t0 + HOUR), 1);
    store.ingest(session("session-start", t0 + 3 * HOUR, "s2"), 1);
    store.ingest(session("session-stop", t0 + 4 * HOUR, "s2"), 1);

    const timezone = "UTC";
    const date = localDayKey(t0, timezone);
    const day = dayBounds(date, timezone);
    const status = buildStatus(store, { idleGapMs: 900_000, now: t0 + 4 * HOUR, day });

    // Two attested hours, and the two hours between them that nothing covers.
    expect(status.measures.attested.union_ms).toBe(2 * HOUR);
    expect(status.uncovered.today_ms).toBe(2 * HOUR);
    expect(status.uncovered.stretches).toEqual([{ start: t0 + HOUR, end: t0 + 3 * HOUR }]);

    const report = renderDay(store, { date, timezone, now: t0 + 4 * HOUR });
    expect(report.text).toContain("Not counted (no measure covers this stretch)");
    expect(report.text).toContain("10:00-12:00   2h 00m");
    expect(report.text).toContain("attest one with: workspan session start --at HH:MM");
    expect(report.text).toMatch(/Attested: 2h 00m/);

    // Without day bounds the review list is empty rather than guessed from "now".
    expect(buildStatus(store, { idleGapMs: 900_000, now: t0 + 4 * HOUR }).uncovered).toEqual({ today_ms: 0, stretches: [] });
  } finally { store.close(); }
});
