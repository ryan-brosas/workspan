import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditReceipts } from "../src/adapters/receipt-audit.ts";
import { appendJsonl, type TimeRecord, type TurnChunk } from "../src/core/ledger.ts";
import { auditTurnReceipts } from "../src/core/native.ts";

/**
 * The first two tests are ported from pi-time-tracker's receipt-audit.test.ts:
 * the classification corpus belongs to the policy, not to the tracker. The third
 * upstream test asserted report-engine integration that Workspan does not have yet.
 */
const summary = (id: string, observedMs = 60_000, modern = true): TimeRecord => ({ version: 1, id, scope: "test-pi-turn", startedAt: "2026-09-27T00:00:00Z", endedAt: "2026-09-27T00:02:00Z", observedMs, outcome: "settled", label: "reddit", ...(modern ? { intervalVersion: 2 as const } : {}) });
const chunk = (id: string): TurnChunk => ({ version: 2, turnId: id, scope: "test-pi-turn", start: "2026-09-27T00:00:00Z", end: "2026-09-27T00:01:00Z", ms: 60_000, capped: false });

test("Bend classifies receipt coverage without making legacy or missing evidence zero hours", () => {
  const rows = [summary("ok"), summary("old", 60_000, false), summary("lost"), summary("partial", 120_000), summary("conflict"), summary("conflict", 120_000)];
  const audited = auditTurnReceipts(rows, [chunk("ok"), chunk("partial"), chunk("orphan"), chunk("conflict")]);
  expect(Object.fromEntries([...audited].map(([id, r]) => [id, r.status]))).toEqual({ ok: "consistent", old: "legacy", lost: "missing", partial: "mismatch", conflict: "conflict", orphan: "checkpoint-only" });
  expect(audited.get("orphan")?.summaryCopies).toBe(0);
  expect(audited.get("conflict")?.durableMs).toBe(60_000);
});

test("exact duplicate summaries are idempotent but metadata conflicts cannot silently choose the last writer", () => {
  const s = summary("same");
  const exact = auditTurnReceipts([s, { ...s }], [chunk("same"), chunk("same")]).get("same")!;
  expect(exact).toEqual({ status: "consistent", durableMs: 60_000, summaryCopies: 2 });
  for (const changed of [{ ...s, label: "analytics" }, { ...s, outcome: "interrupted" as const }, { ...s, intervalVersion: undefined }]) {
    for (const rows of [[s, changed], [changed, s]]) expect(auditTurnReceipts(rows, [chunk("same")]).get("same")?.status).toBe("conflict");
  }
});

function fixture(): { dir: string; turns: string; chunks: string } {
  const dir = mkdtempSync(join(tmpdir(), "workspan-audit-"));
  return { dir, turns: join(dir, "turns.jsonl"), chunks: join(dir, "chunks.jsonl") };
}

test("one scope at a time, and the report says what it found without importing anything", () => {
  const { dir, turns, chunks } = fixture();
  try {
    appendJsonl(turns, summary("a"));
    appendJsonl(turns, { ...summary("b"), scope: "other-pi-turn" });
    appendJsonl(chunks, chunk("a"));
    const report = auditReceipts({ turnsLog: turns, chunksLog: chunks });
    expect(report.input).toMatchObject({ turns: 2, chunks: 1, scopes: 2, malformed_lines: 0 });
    // "a" has a summary and its counted interval; "b" is a summary with no counted
    // evidence, which is missing rather than zero. A chunk with no summary would be
    // checkpoint-only, and is covered below.
    expect(report.by_status).toMatchObject({ consistent: 1, missing: 1 });
    // A receipt audit never ingests, and it never prints a task label.
    expect(report.imported).toBe(0);
    expect(JSON.stringify(report)).not.toContain("reddit");
    expect(report.rows.map(r => `${r.scope}:${r.id}:${r.status}`)).toEqual(["other-pi-turn:b:missing", "test-pi-turn:a:consistent"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("conflicts, mismatches and missing receipts are listed for review rather than smoothed over", () => {
  const { dir, turns, chunks } = fixture();
  try {
    appendJsonl(turns, summary("g"));
    appendJsonl(turns, summary("g", 120_000));       // two summaries, different metadata
    appendJsonl(turns, summary("m", 120_000));       // one summary, counted evidence says 60s
    appendJsonl(chunks, chunk("m"));
    appendJsonl(chunks, chunk("orphan"));            // counted evidence with no summary
    const report = auditReceipts({ turnsLog: turns, chunksLog: chunks });
    expect(report.by_status.conflict).toBe(1);
    expect(report.by_status.mismatch).toBe(1);
    expect(report.by_status["checkpoint-only"]).toBe(1);
    expect(report.review.sort()).toEqual(["conflict: g", "mismatch: m"]);
    // The scope figure is counted evidence summed over identities, not one receipt's max.
    expect(report.scopes).toEqual([{ scope: "test-pi-turn", receipts: 3, counted_ms: 120_000, review: 2 }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("malformed lines are counted and reported, never silently dropped", () => {
  const { dir, turns, chunks } = fixture();
  try {
    writeFileSync(turns, JSON.stringify(summary("ok")) + "\ntruncated{not json\n");
    writeFileSync(chunks, JSON.stringify(chunk("ok")) + "\n");
    const report = auditReceipts({ turnsLog: turns, chunksLog: chunks });
    expect(report.input.malformed_lines).toBe(1);
    expect(report.input.turns).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
