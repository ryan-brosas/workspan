import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspanStore } from "../src/daemon/db.ts";
import { validateEvent } from "../src/daemon/evidence.ts";
import { buildStatus } from "../src/daemon/measures.ts";

const roots: string[] = [];
const t0 = 1_700_000_000_000;
const event = (kind: string, at: number, session = "s1", project = "coral") =>
  validateEvent({ v: 1, source: "manual", instance: "cli", session, event: `${kind}-${at}`, kind, at, origin: "attested", project });

function store(): WorkspanStore {
  const root = mkdtempSync(join(tmpdir(), "workspan-session-"));
  roots.push(root);
  return new WorkspanStore(join(root, "workspan.sqlite"));
}

test("a paused span leaves attested hours and the clock freezes while paused", () => {
  const s = store();
  try {
    s.ingest(event("session-start", t0), 1);
    s.ingest(event("session-pause", t0 + 60_000), 1);
    s.ingest(event("session-resume", t0 + 120_000), 1);
    s.ingest(event("session-stop", t0 + 180_000), 1);
    const status = buildStatus(s, { idleGapMs: 900_000, now: t0 + 240_000 });
    // Sixty minutes of work, a sixty minute pause, then sixty more: the pause is
    // not attested, so two hours of session mean two hours of hours.
    expect(status.measures.attested.union_ms).toBe(120_000);
    expect(status.measures.attested.projects).toEqual([{ project: "coral", ms: 120_000 }]);
    expect(status.current_session).toBeNull();
  } finally { s.close(); }
});

test("the provisional clock freezes at the pause, whatever time passes", () => {
  const s = store();
  try {
    s.ingest(event("session-start", t0), 1);
    s.ingest(event("session-pause", t0 + 60_000), 1);
    const first = buildStatus(s, { idleGapMs: 900_000, now: t0 + 300_000 }).current_session;
    const later = buildStatus(s, { idleGapMs: 900_000, now: t0 + 3_600_000 }).current_session;
    expect(first?.state).toBe("paused");
    expect(first?.provisional_ms).toBe(60_000);
    expect(later?.provisional_ms).toBe(60_000);
  } finally { s.close(); }
});

test("a replayed pause is a duplicate, and a redundant pause records no transition", () => {
  const s = store();
  try {
    s.ingest(event("session-start", t0), 1);
    s.ingest(event("session-pause", t0 + 60_000), 1);
    // Same identity redelivered: a duplicate, not a second transition.
    expect(s.ingest(event("session-pause", t0 + 60_000), 2).status).toBe("duplicate");
    // A new pause event while already paused: the state guard skips it.
    s.ingest(event("session-pause", t0 + 90_000, "s1x"), 2).status;
    s.ingest(event("session-resume", t0 + 120_000), 1);
    s.ingest(event("session-stop", t0 + 180_000), 1);
    expect(s.sessionTransitions()).toHaveLength(2);
    expect(buildStatus(s, { idleGapMs: 900_000, now: t0 + 240_000 }).measures.attested.union_ms).toBe(120_000);
  } finally { s.close(); }
});

test("stopping while paused keeps no trailing span", () => {
  const s = store();
  try {
    s.ingest(event("session-start", t0), 1);
    s.ingest(event("session-pause", t0 + 60_000), 1);
    s.ingest(event("session-stop", t0 + 3_600_000), 1);
    expect(buildStatus(s, { idleGapMs: 900_000, now: t0 + 3_700_000 }).measures.attested.union_ms).toBe(60_000);
  } finally { s.close(); }
});

test("a switch closes the old segment and opens the new one at the same instant", () => {
  const s = store();
  try {
    s.ingest(event("session-start", t0, "first", "coral"), 1);
    s.ingest(event("session-stop", t0 + 300_000, "first", "coral"), 1);
    s.ingest(event("session-start", t0 + 300_000, "second", "other"), 1);
    const status = buildStatus(s, { idleGapMs: 900_000, now: t0 + 400_000 });
    expect(status.measures.attested.projects).toEqual([{ project: "coral", ms: 300_000 }]);
    expect(status.current_session?.project).toBe("other");
    expect(status.current_session?.provisional_ms).toBe(100_000);
    expect(status.coverage.open_sessions).toBe(1);
  } finally { s.close(); }
});

afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
