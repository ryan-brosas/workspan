import { expect, test } from "bun:test";
import { reconcileIntervals } from "../src/core/native.ts";
import { partitionByProject, sweep, totalOf } from "../src/daemon/measures.ts";

const H = 3_600_000;

test("the derived sweep agrees with the Bend policy it is derived from", () => {
  const intervals = [{ start: 0, end: 1_000 }, { start: 500, end: 2_000 }, { start: 5_000, end: 6_000 }];
  const [authority] = reconcileIntervals([intervals]);
  expect(totalOf(sweep(intervals))).toBe(authority);
  expect(sweep(intervals)).toEqual([{ start: 0, end: 2_000 }, { start: 5_000, end: 6_000 }]);
});

test("overlapping evidence in one measure unions once", () => {
  const [union] = reconcileIntervals([[{ start: 0, end: H }, { start: H / 2, end: 2 * H }]]);
  expect(union).toBe(2 * H);
});

test("allocation partitions the union at assignment boundaries", () => {
  const intervals = [
    { start: 0, end: H, project: "coral" },
    { start: H, end: 2 * H },
    { start: 2 * H, end: 3 * H, project: "coral" },
    { start: 2 * H + 60_000, end: 3 * H, project: "other" },
  ];
  const part = partitionByProject(intervals);
  const allocated = [...part.projects.values()].reduce((sum, ms) => sum + ms, 0);
  expect(part.total).toBe(3 * H);
  expect(allocated + part.unallocated + part.ambiguous).toBe(part.total);
  expect(part.projects.get("coral")).toBe(H + 60_000);
  expect(part.ambiguous).toBe(H - 60_000);
  expect(part.unallocated).toBe(H);
  // The authority agrees with the derived partition's total.
  expect(reconcileIntervals([intervals.map(({ start, end }) => ({ start, end }))])[0]).toBe(part.total);
});

test("contiguous projectless evidence is not absorbed by the neighbouring project", () => {
  const part = partitionByProject([
    { start: 0, end: H, project: "coral" },
    { start: H, end: 2 * H },
  ]);
  expect(part.projects.get("coral")).toBe(H);
  expect(part.unallocated).toBe(H);
  expect(part.ambiguous).toBe(0);
});

test("a segment two projects both claim is ambiguous, never split or doubled", () => {
  const part = partitionByProject([
    { start: 0, end: H, project: "coral" },
    { start: H / 2, end: H, project: "other" },
  ]);
  expect(part.projects.get("coral")).toBe(H / 2);
  expect(part.ambiguous).toBe(H / 2);
  expect(part.projects.get("other")).toBeUndefined();
});

test("the partition stays usable when history grows", () => {
  // A quadratic partition passed at small sizes and collapsed here: 20,000 windows
  // took tens of seconds. The bound is generous on purpose — it catches the growth
  // class, not the constant factor.
  const windows = Array.from({ length: 20_000 }, (_, i) => ({ start: i * 600_000, end: i * 600_000 + 300_000, project: i % 3 === 0 ? "coral" : undefined }));
  const started = performance.now();
  const part = partitionByProject(windows);
  const elapsed = performance.now() - started;
  const allocated = [...part.projects.values()].reduce((sum, ms) => sum + ms, 0);
  expect(allocated + part.unallocated + part.ambiguous).toBe(part.total);
  expect(part.total).toBe(6_000_000_000); // 20,000 disjoint 300s windows
  expect(elapsed).toBeLessThan(3_000);
}, 30_000);

test("a zero-length interval contributes no time", () => {
  expect(totalOf(sweep([{ start: 5, end: 5 }]))).toBe(0);
});
