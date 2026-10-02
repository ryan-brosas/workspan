import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJsonl, type TurnChunk } from "../src/core/ledger.ts";
import { migratePiHistory } from "../src/adapters/migrate.ts";
import { planPiHistory } from "../src/adapters/pi-history.ts";
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
  expect(report.written).toEqual({ accepted: 12, duplicates: 0, conflicts: 0 });
  expect(report.reconciliation).toMatchObject({ source_ms: 180_000, target_ms: 180_000, equal: true, identities: 12, open_turns: 0 });

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
  expect(second.written).toEqual({ accepted: 0, duplicates: 12, conflicts: 0 });
  expect(second.reconciliation).toMatchObject({ source_ms: 180_000, target_ms: 180_000, equal: true });
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

afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
