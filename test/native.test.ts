import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { auditTurnReceipts, engineLabel, nativeExecutable, reconcileIntervals } from "../src/core/native.ts";
import type { TimeRecord, TurnChunk } from "../src/core/ledger.ts";
import { evaluateAudit, evaluateIntervals } from "../src/core/generated/policy.mjs";

/** Isolated module copies live beside their own generated directory; the source does not. */
const coreDir = join(import.meta.dir, "..", "src", "core");

/** The generated policy is the default lane; clear any explicit native selection. */
function generated<T>(run: () => T): T {
  const bend = process.env.BEND_EXECUTABLE, binary = process.env.WORKTIME_BEND_BINARY;
  delete process.env.BEND_EXECUTABLE; delete process.env.WORKTIME_BEND_BINARY;
  try { return run(); } finally {
    if (bend === undefined) delete process.env.BEND_EXECUTABLE; else process.env.BEND_EXECUTABLE = bend;
    if (binary === undefined) delete process.env.WORKTIME_BEND_BINARY; else process.env.WORKTIME_BEND_BINARY = binary;
  }
}
const nativeLane = () => ({ nativeExecutable: nativeExecutable() });

test("native selection does not load the generated artifact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "worktime-native-lazy-"));
  try {
    copyFileSync(join(coreDir, "native.ts"), join(dir, "native.ts"));
    const cloned = await import(join(dir, "native.ts"));
    expect(cloned.engineLabel({ nativeExecutable: "native" })).toBe("native Bend");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("generated policy exceptions are wrapped with rebuild guidance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "worktime-native-policy-error-"));
  try {
    copyFileSync(join(coreDir, "native.ts"), join(dir, "native.ts"));
    mkdirSync(join(dir, "generated"));
    writeFileSync(join(dir, "generated", "policy.mjs"), 'export const evaluateIntervals = () => { throw new RangeError("test failure"); }; export const evaluateAudit = evaluateIntervals;');
    const cloned = await import(join(dir, "native.ts"));
    expect(() => cloned.reconcileIntervals([[{ start: 0, end: 1 }]])).toThrow(/Generated Bend policy evaluation failed: test failure; rebuild with bun run build:bend/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("empty native override falls through to a configured compiler", () => {
  const old = process.env.WORKTIME_BEND_BINARY;
  process.env.WORKTIME_BEND_BINARY = "";
  try { expect(engineLabel({ bendExecutable: "bend" })).toBe("native Bend"); }
  finally { if (old === undefined) delete process.env.WORKTIME_BEND_BINARY; else process.env.WORKTIME_BEND_BINARY = old; }
});

const mixed = [
  [{ start: 5, end: 20 }, { start: 0, end: 10 }, { start: 5, end: 20 }, { start: 30, end: 40 }, { start: 20, end: 25 }],
  [{ start: Date.parse("2026-09-27T00:00:00Z"), end: Date.parse("2026-09-27T00:01:00Z") }, { start: Date.parse("2026-09-27T00:00:20Z"), end: Date.parse("2026-09-27T00:01:20Z") }],
  [],
  [{ start: 2 ** 48 - 10, end: 2 ** 48 - 1 }],
  [{ start: 0, end: 0 }],
];

for (const [lane, makeOptions] of [["generated", () => undefined], ["native", nativeLane]] as const) {
  test(`${lane} Bend deduplicates nested, touching and unsorted intervals at epoch precision`, () => {
    const options = makeOptions();
    const run = () => reconcileIntervals(structuredClone(mixed), options);
    expect(lane === "generated" ? generated(run) : run()).toEqual([35, 80_000, 0, 9, 0]);
  }, 90_000);

  test(`${lane} reducer agrees with a seeded discrete-time coverage oracle`, () => {
    const options = makeOptions();
    let seed = 73;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    const groups = Array.from({ length: 50 }, () => Array.from({ length: 35 }, () => { const start = random() % 200; return { start, end: start + random() % 35 }; }));
    const expected = groups.map(ivs => { const covered = new Set<number>(); for (const iv of ivs) for (let t = iv.start; t < iv.end; t++) covered.add(t); return covered.size; });
    const run = () => reconcileIntervals(groups, options);
    expect(lane === "generated" ? generated(run) : run()).toEqual(expected);
  }, 90_000);

  test(`${lane} union ignores interval order and duplicate rows`, () => {
    const options = makeOptions();
    const ivs = [{ start: 0, end: 10 }, { start: 5, end: 20 }, { start: 30, end: 40 }, { start: 5, end: 20 }];
    const expected = 20 + 10;
    const permutations = [ivs, [...ivs].reverse(), [ivs[1], ivs[3], ivs[0], ivs[2]]];
    for (const rows of permutations) {
      const run = () => reconcileIntervals([rows, [...rows, ...rows]], options);
      expect(lane === "generated" ? generated(run) : run()).toEqual([expected, expected]);
    }
  }, 90_000);
}

const malformedIntervals = ["0,20,10", "0,-1,20", "0,1,2,3", "secret,1,2", "0,1,281474976710656", "0,1.5,2", "0,1\r0,20", "0,1,2\r0"];

test("generated policy rejects malformed transport instead of guessing", () => {
  for (const input of malformedIntervals) {
    expect(evaluateIntervals(input)).toEqual({ $: "None" });
  }
});

test("generated policy rejects malformed receipt audit transport", () => {
  for (const input of ["0,1,2", "x,1,1,1,1,1,0", "0,0,0,2,0,0,0", "0,0,0,1,0,2,0", "0,0,0,1,0.5,1,0", "0,1\r0,1,1,10,1,0"]) {
    expect(evaluateAudit(input)).toEqual({ $: "None" });
  }
});

test("generated parsers skip field parsing after the first failure", () => {
  // Parsing this later field would overflow Base's recursive String.length.
  const oversized = "9".repeat(100_000);
  expect(evaluateIntervals(`invalid\n0,0,${oversized}`)).toEqual({ $: "None" });
  expect(evaluateAudit(`invalid\n0,${oversized},1,1,1,1,0`)).toEqual({ $: "None" });
});

test("generated policies accept CRLF rows", () => {
  expect(evaluateIntervals("0,0,10\r\n0,5,15\r\n")).toEqual({ $: "Some", value: "worktime-v1\n0,15\n" });
  expect(evaluateAudit("0,10,1,1,10,1,0\r\n0,20,1,1,20,1,1\r\n")).toEqual({ $: "Some", value: "worktime-audit-v1\n0,5,10,2\n" });
});

test("Batch.sort retains first input row for equal group keys", () => {
  expect(evaluateAudit("0,10,1,1,10,1,0\n0,20,1,1,20,1,1")).toEqual({ $: "Some", value: "worktime-audit-v1\n0,5,10,2\n" });
  expect(evaluateAudit("0,20,1,1,20,1,1\n0,10,1,1,10,1,0")).toEqual({ $: "Some", value: "worktime-audit-v1\n0,5,20,2\n" });
});

test("native CLI rejects malformed transport and the bridge fails explicitly without a native executable", () => {
  const native = nativeLane();
  const dir = mkdtempSync(join(tmpdir(), "worktime-bend-test-"));
  try {
    const file = join(dir, "input");
    for (const input of malformedIntervals) {
      writeFileSync(file, input, { mode: 0o600 });
      const r = spawnSync(nativeExecutable(), ["--threads", "1", "--", file], { encoding: "utf8", timeout: 10_000 });
      expect(r.status).not.toBe(0); expect(r.stderr + r.stdout).not.toContain(input);
    }
    expect(() => reconcileIntervals([[{ start: 0, end: 10 }]], { nativeExecutable: join(dir, "missing") })).toThrow("Bend reconciliation failed");
    expect(() => reconcileIntervals([[{ start: 0, end: 2 ** 48 }]])).toThrow("Invalid interval bounds");
    expect(() => reconcileIntervals([[{ start: 0, end: 2 ** 48 }]], native)).toThrow("Invalid interval bounds");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Small fixtures hid a real failure: Base string/list helpers recurse per character or
// row, so a year of epoch receipts overflowed the JS stack. Both lanes must now handle
// the sizes a real ledger reaches, not just toy numbers.
for (const [lane, makeOptions] of [["generated", () => undefined], ["native", nativeLane]] as const) {
  test(`${lane} reconciles 1,200 overlapping epoch receipts and 12,000 groups without stack growth`, () => {
    const options = makeOptions();
    const base = Date.parse("2026-01-01T00:00:00Z"), minute = 60_000;
    let seed = 20_260_101;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    const intervals = Array.from({ length: 1200 }, () => { const start = base + (random() % 3600) * minute; return { start, end: start + (random() % 120) * minute }; });
    const covered = new Set<number>();
    for (const iv of intervals) for (let m = iv.start; m < iv.end; m += minute) covered.add(m);
    const rows = [...intervals, ...intervals.slice(0, 300)];
    const groups = Array.from({ length: 12_000 }, (_, i) => [{ start: base + i * 1000, end: base + i * 1000 + 3000 }]);
    const run = () => {
      const [union] = reconcileIntervals([rows], options);
      const totals = reconcileIntervals(groups, options);
      return { union, expected: covered.size * minute, count: totals.length, distinct: new Set(totals) };
    };
    const result = lane === "generated" ? generated(run) : run();
    expect(result.union).toBe(result.expected);
    expect(result.count).toBe(12_000);
    expect([...result.distinct]).toEqual([3000]);
  }, 90_000);

  test(`${lane} audits 12,000 receipts without stack growth`, () => {
    const options = makeOptions();
    const base = Date.parse("2026-01-01T00:00:00Z"), scope = "scale-pi-turn", five = 5 * 60_000;
    const at = (ms: number) => new Date(base + ms).toISOString();
    const turns: TimeRecord[] = [], chunks: TurnChunk[] = [];
    for (let i = 0; i < 12_000; i++) {
      const start = i * 60_000;
      turns.push({ version: 1, id: `t${i}`, startedAt: at(start), endedAt: at(start + five), observedMs: five, outcome: "settled", scope, intervalVersion: 2 });
      chunks.push({ version: 2, turnId: `t${i}`, scope, start: at(start), end: at(start + five), ms: five, capped: false });
    }
    const run = () => { const audited = auditTurnReceipts(turns, chunks, options); return { size: audited.size, statuses: [...new Set([...audited.values()].map(a => a.status))] }; };
    const result = lane === "generated" ? generated(run) : run();
    expect(result.size).toBe(12_000);
    expect(result.statuses).toEqual(["consistent"]);
  }, 90_000);
}

test("the emitted policy parses a 12,000-row batch directly, without the adapter", () => {
  const rows = Array.from({ length: 12_000 }, (_, i) => `0,${1_000_000 + i * 60_000},${1_000_000 + i * 60_000 + 180_000}`);
  const union = generated(() => evaluateIntervals(rows.join("\n"))) as { $: string; value?: string };
  expect(union.$).toBe("Some");
  expect(union.value).toBe(`worktime-v1\n0,${(12_000 - 1) * 60_000 + 180_000}\n`);
  const auditRows = Array.from({ length: 12_000 }, (_, i) => `${i},300000,1,1,300000,1,${i}`).join("\n");
  const audited = generated(() => evaluateAudit(auditRows)) as { $: string; value?: string };
  expect(audited.$).toBe("Some");
  const lines = audited.value!.trimEnd().split("\n");
  expect(lines).toHaveLength(12_001);
  expect(lines[0]).toBe("worktime-audit-v1");
  expect(lines.at(-1)).toBe("11999,0,300000,1");
}, 90_000);
