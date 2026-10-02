import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJsonl, type TurnChunk } from "../src/core/ledger.ts";
import { migratePiHistory } from "../src/adapters/migrate.ts";
import { planPiHistory } from "../src/adapters/pi-history.ts";
import { DatabaseSync } from "node:sqlite";
import { WorkspanStore } from "../src/daemon/db.ts";
import { buildStatus } from "../src/daemon/measures.ts";

const roots: string[] = [];
const base = Date.parse("2026-09-28T12:00:00Z");
const chunk = (turnId: string, index: number, scope = "work-pi-turn"): TurnChunk => ({
  version: 2, turnId, scope,
  start: new Date(base + index * 60_000).toISOString(),
  end: new Date(base + index * 60_000 + 30_000).toISOString(),
  ms: 30_000, capped: false, sessionId: "session-a",
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "workspan-migrate-"));
  roots.push(dir);
  const chunks = join(dir, "chunks.jsonl");
  for (const [turn, index] of [["t1", 0], ["t1", 1], ["t1", 2], ["t2", 3], ["t2", 4]] as const) appendJsonl(chunks, chunk(turn, index));
  appendJsonl(chunks, chunk("t3", 5, "other-pi-turn"));
  return { dir, chunks, target: join(dir, "target.sqlite") };
}

test("a plan imports nothing and says which evidence is unattributed", () => {
  const { chunks, target } = fixture();
  const plan = planPiHistory({ chunksLog: chunks, scopeMap: { work: "coral" } });
  expect(plan.events).toHaveLength(12);
  expect(plan.unmapped).toEqual(["other-pi-turn"]);
  expect(plan.scopes).toEqual([
    { scope: "other-pi-turn", project: null, chunks: 1, turns: 1, counted_ms: 30_000 },
    { scope: "work-pi-turn", project: "coral", chunks: 5, turns: 2, counted_ms: 150_000 },
  ]);
  // A plan never opens the target.
  const dry = migratePiHistory({ chunksLog: chunks, targetDatabase: target, scopeMap: { work: "coral" } });
  expect(dry.applied).toBe(false);
  expect(dry.reconciliation).toBeNull();
  expect(existsSync(target)).toBe(false);
});

test("an applied migration reconciles the imported measure against the source", () => {
  const { chunks, target } = fixture();
  const report = migratePiHistory({ chunksLog: chunks, targetDatabase: target, scopeMap: { work: "coral" }, apply: true });
  expect(report.written).toMatchObject({ accepted: 12, duplicates: 0, conflicts: 0 });
  expect(report.reconciliation).toMatchObject({
    agent: { source_ms: 180_000, target_ms: 180_000, equal: true },
    // No tracker database was given, so no windows were migrated and both sides are zero.
    inferred: { source_ms: 0, target_ms: 0, equal: true },
    identities: 12,
    open_turns: 0,
  });

  // Imported evidence is agent runtime, attributed only where a mapping said so.
  const store = new WorkspanStore(target);
  try {
    const status = buildStatus(store, { idleGapMs: 900_000 });
    expect(status.measures.agent.union_ms).toBe(180_000);
    expect(status.measures.agent.projects).toEqual([{ project: "coral", ms: 150_000 }]);
    expect(status.measures.agent.unallocated_ms).toBe(30_000);
    // It is never attended work and never inferred attendance.
    expect(status.measures.inferred.union_ms).toBe(0);
    expect(status.measures.attested.union_ms).toBe(0);
  } finally { store.close(); }
});

test("running the migration twice adds nothing and keeps the reconciliation intact", () => {
  const { chunks, target } = fixture();
  migratePiHistory({ chunksLog: chunks, targetDatabase: target, scopeMap: { work: "coral" }, apply: true });
  const second = migratePiHistory({ chunksLog: chunks, targetDatabase: target, scopeMap: { work: "coral" }, apply: true });
  expect(second.written).toMatchObject({ accepted: 0, duplicates: 12, conflicts: 0 });
  expect(second.reconciliation?.agent).toEqual({ source_ms: 180_000, target_ms: 180_000, equal: true });
});

test("the daemon's own database is refused unless it is explicitly allowed", () => {
  const { chunks, target } = fixture();
  const previous = process.env.WORKSPAN_DB_PATH;
  process.env.WORKSPAN_DB_PATH = target;
  try {
    expect(() => migratePiHistory({ chunksLog: chunks, targetDatabase: target, apply: true })).toThrow(/refusing to migrate into the daemon/);
    const allowed = migratePiHistory({ chunksLog: chunks, targetDatabase: target, apply: true, allowLiveDatabase: true });
    expect(allowed.applied).toBe(true);
  } finally { if (previous === undefined) delete process.env.WORKSPAN_DB_PATH; else process.env.WORKSPAN_DB_PATH = previous; }
});

test("rows the typed reader discards are reported, not inherited silently", () => {
  const { chunks } = fixture();
  const reversed = chunk("t9", 9);
  appendJsonl(chunks, { ...reversed, start: reversed.end, end: reversed.start });
  const plan = planPiHistory({ chunksLog: chunks });
  // readChunks drops a reversed row without saying so; the planner counts the loss.
  expect(plan.input).toMatchObject({ chunks: 6, invalid_rows: 1, malformed_lines: 0, skipped: 0 });
  expect(plan.events).toHaveLength(12);
});

/** The existing tracker's own schema, as installed. */
function trackerFixture(dir: string): string {
  const path = join(dir, "pi-tracker.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`create table workspaces (root text primary key, client text not null, explicit integer not null default 0);
    create table windows (id text primary key, root text not null, client text not null, sessionId text not null, task text not null, start integer not null, end integer not null, kind text not null)`);
  db.prepare("insert into workspaces values(?,?,?)").run("/mnt/ssd/work/project/coral", "coral", 1);
  db.prepare("insert into workspaces values(?,?,?)").run("/tmp", "tmp", 0);
  const insert = db.prepare("insert into windows values(?,?,?,?,?,?,?,?)");
  insert.run("w1", "/mnt/ssd/work/project/coral", "coral", "s1", "invoices", base, base + 600_000, "work");
  insert.run("w2", "/mnt/ssd/work/project/coral", "coral", "s1", "invoices", base + 300_000, base + 900_000, "work");
  insert.run("w3", "/tmp", "tmp", "s1", "scratch", base + 3_600_000, base + 3_900_000, "work");
  // A gap row is the tracker's record of excluded time, so it must not be imported.
  insert.run("g1", "/mnt/ssd/work/project/coral", "coral", "s1", "invoices", base + 1_200_000, base + 1_800_000, "gap");
  db.close();
  return path;
}

test("the tracker database brings its own attribution, and unconfirmed labels stay marked", () => {
  const { dir, chunks, target } = fixture();
  const trackerDatabase = trackerFixture(dir);
  const plan = migratePiHistory({ chunksLog: chunks, targetDatabase: target, trackerDatabase });
  expect(plan.applied).toBe(false);
  expect(plan.tracker).toMatchObject({ bindings: 2, windows: 3, skipped_windows: 0, provisional_projects: ["tmp"] });

  const report = migratePiHistory({ chunksLog: chunks, targetDatabase: target, trackerDatabase, apply: true });
  expect(report.written).toMatchObject({ windows: 3, bindings: 2, accepted: 12 });
  // Inferred attendance reconciles: 600s + 300s of overlap -> 900s, plus 300s.
  expect(report.reconciliation?.inferred).toEqual({ source_ms: 1_200_000, target_ms: 1_200_000, equal: true });
  expect(report.reconciliation?.agent.equal).toBe(true);

  const store = new WorkspanStore(target);
  try {
    const bindings = store.projectBindings();
    expect(bindings.map(b => [b.project, b.explicit])).toEqual([["coral", true], ["tmp", false]]);
    const status = buildStatus(store, { idleGapMs: 900_000 });
    expect(status.measures.inferred.union_ms).toBe(1_200_000);
    expect(status.measures.inferred.projects).toEqual([{ project: "coral", ms: 900_000 }, { project: "tmp", ms: 300_000 }]);
    expect(status.measures.inferred.unallocated_ms).toBe(0);
  } finally { store.close(); }
});

test("replaying a tracker migration keeps one window row per source window", () => {
  const { dir, chunks, target } = fixture();
  const trackerDatabase = trackerFixture(dir);
  migratePiHistory({ chunksLog: chunks, targetDatabase: target, trackerDatabase, apply: true });
  migratePiHistory({ chunksLog: chunks, targetDatabase: target, trackerDatabase, apply: true });
  const store = new WorkspanStore(target);
  try {
    expect(store.windows()).toHaveLength(3);
    expect(store.projectBindings()).toHaveLength(2);
    expect(store.observations()).toHaveLength(12);
  } finally { store.close(); }
});

afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
