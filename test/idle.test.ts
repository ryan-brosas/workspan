import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspanStore, type Observation } from "../src/daemon/db.ts";
import { validateEvent, type EvidenceEvent } from "../src/daemon/evidence.ts";
import { buildStatus, coveringSession, idleStretches, type StatusCache } from "../src/daemon/measures.ts";
import type { SessionRow } from "../src/daemon/db.ts";
import { renderDay } from "../src/daemon/day.ts";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const t0 = Date.parse("2026-10-03T09:00:00Z");
const HOUR = 3_600_000;
/** What the collector writes: a seat annotation, unknown origin, no project. */
const desktop = { source: "desktop", instance: "omarchy-desktop", session: "omarchy-desktop", kind: "interaction", origin: "unknown" } as const;
/** The store's view of an event: what `observations()` returns and the reader consumes. */
const observed = (event: EvidenceEvent): Observation => ({ ...event, eventId: `${event.source}\u0000${event.session}\u0000${event.event}`, receivedAt: event.at });
const idle = (at: number, timeout: number) => observed(validateEvent({ ...desktop, event: `idle:${at}:${timeout}`, at }));
const resumed = (at: number, timeout: number) => observed(validateEvent({ ...desktop, event: `resumed:${at}:${timeout}`, at }));
const session = (kind: string, at: number) => validateEvent({ v: 1, source: "manual", instance: "cli", session: "s1", event: `${kind}-${at}`, kind, at, origin: "attested", project: "coral" });

function store(): WorkspanStore {
  const root = mkdtempSync(join(tmpdir(), "workspan-idle-"));
  roots.push(root);
  return new WorkspanStore(join(root, "workspan.sqlite"));
}

test("a review attaches to the session that covers the stretch, never to a removed one", () => {
  const row = (over: Partial<SessionRow> & Pick<SessionRow, "id" | "session" | "startedAt" | "endedAt">): SessionRow => ({
    project: "coral", root: null, state: over.endedAt === null ? "running" : "stopped", removedAt: null, removedReason: null, ...over,
  });
  const rows = [
    row({ id: "a", session: "s-a", startedAt: t0, endedAt: t0 + HOUR }),
    row({ id: "b", session: "s-b", startedAt: t0 + 2 * HOUR, endedAt: null }),
    row({ id: "c", session: "s-c", startedAt: t0, endedAt: t0 + HOUR, removedAt: t0 + HOUR, removedReason: "noise" }),
  ];
  expect(coveringSession(rows, t0 + 60_000)?.session).toBe("s-a");
  expect(coveringSession(rows, t0 + 3 * HOUR)?.session).toBe("s-b");
  expect(coveringSession(rows, t0 - 60_000)).toBeNull();
  // A removed session is a correction, not a place to put new evidence.
  expect(coveringSession([rows[2]], t0 + 60_000)).toBeNull();
  // Two overlapping intervals after a hand correction: the latest start was in effect.
  expect(coveringSession([...rows, row({ id: "d", session: "s-d", startedAt: t0 + 30 * 60_000, endedAt: t0 + HOUR })], t0 + 45 * 60_000)?.session).toBe("s-d");
});

test("a quiet stretch starts at the stamp minus the timeout it waited out", () => {
  expect(idleStretches([idle(t0, 300_000), resumed(t0 + 900_000, 300_000)]))
    .toEqual([{ from: t0 - 300_000, to: t0 + 900_000 }]);
});

test("two notifications with no resume between them are one stretch, not two", () => {
  const stretches = idleStretches([idle(t0, 60_000), idle(t0 + 600_000, 60_000), resumed(t0 + 900_000, 60_000)]);
  expect(stretches).toEqual([{ from: t0 - 60_000, to: t0 + 900_000 }]);
});

test("a resume with no idle before it is not evidence of a stretch", () => {
  expect(idleStretches([resumed(t0, 300_000)])).toEqual([]);
});

test("only desktop interaction tokens with a plausible timeout are read", () => {
  const noise = [
    observed(validateEvent({ ...desktop, source: "pi", event: `idle:${t0}:300000`, at: t0 })),
    observed(validateEvent({ ...desktop, event: `focus:${t0}`, at: t0 })),
    observed(validateEvent({ ...desktop, event: `idle:${t0}`, at: t0 })),
    observed(validateEvent({ ...desktop, event: `idle:${t0}:999999999999`, at: t0 })),
    observed(validateEvent({ ...desktop, event: `idle:${t0}:soon`, at: t0 })),
  ];
  expect(idleStretches(noise)).toEqual([]);
  // An open stretch says the seat is quiet right now; it is not given an end it has not had.
  expect(idleStretches([idle(t0, 300_000)])).toEqual([{ from: t0 - 300_000, to: null }]);
});

test("a resume before the stretch began contributes nothing instead of a negative interval", () => {
  expect(idleStretches([idle(t0, 300_000), resumed(t0 - 600_000, 300_000)])).toEqual([]);
});

test("an idle annotation is recorded, changes no measure, and is listed for review", () => {
  const s = store();
  try {
    s.ingest(session("session-start", t0), 1);
    s.ingest(session("session-stop", t0 + HOUR), 1);
    const before = buildStatus(s, { idleGapMs: 900_000, now: t0 + HOUR });

    s.ingest(idle(t0 + 1_200_000, 300_000), 1);
    s.ingest(resumed(t0 + 1_800_000, 300_000), 1);
    const after = buildStatus(s, { idleGapMs: 900_000, now: t0 + HOUR });

    // Recorded as coverage, and nothing else moved: not a measure, not the session.
    expect(after.coverage.events).toBe(before.coverage.events + 2);
    expect(after.measures).toEqual(before.measures);
    expect(after.current_session).toEqual(before.current_session);
    expect(after.last_idle).toEqual({ from: t0 + 1_200_000 - 300_000, to: t0 + 1_800_000, idle_ms: 900_000, still_away: false });

    const day = renderDay(s, { date: "2026-10-03", timezone: "UTC", now: t0 + HOUR });
    expect(day.text).toContain("Away (seat idle annotations, never subtracted)");
    expect(day.text).toContain("09:15-09:30   15m");
    expect(day.text).toMatch(/Attested: 1h 00m/);
  } finally { s.close(); }
});

test("an open stretch is the one idle field that moves with the clock, and the projection is reused", () => {
  const s = store();
  try {
    s.ingest(idle(t0, 300_000), 1);
    const cache: StatusCache = {};
    const first = buildStatus(s, { idleGapMs: 900_000, now: t0 + 600_000, cache });
    const second = buildStatus(s, { idleGapMs: 900_000, now: t0 + 900_000, cache });
    // `from` predates the stamp by the timeout: the quiet stretch is longer than
    // the moment it was noticed, and the arithmetic lives in the daemon, not the widget.
    expect(first.last_idle).toEqual({ from: t0 - 300_000, to: null, idle_ms: 900_000, still_away: true });
    expect(second.last_idle).toEqual({ from: t0 - 300_000, to: null, idle_ms: 1_200_000, still_away: true });
    expect(cache.builds).toBe(1);

    // And the report says the resume is missing rather than inventing a return.
    const day = renderDay(s, { date: "2026-10-03", timezone: "UTC", now: t0 + 900_000 });
    expect(day.text).toContain("08:55-open   20m (no resume recorded)");
  } finally { s.close(); }
});
