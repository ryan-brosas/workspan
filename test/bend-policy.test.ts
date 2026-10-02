import { expect, test } from "bun:test";
import { engineLabel, reconcileIntervals } from "../src/core/native.ts";

/**
 * The inherited policy has to work here with no compiler, no Pi and no tracker:
 * these four assertions are what "Workspan owns the accounting" means in code.
 */

test("the default lane is the generated policy, not a native build", () => {
  expect(engineLabel()).toBe("generated Bend policy");
});

test("one measure unions overlapping intervals instead of adding them", () => {
  expect(reconcileIntervals([[{ start: 0, end: 1_000_000 }, { start: 500_000, end: 2_000_000 }]])).toEqual([2_000_000]);
});

test("disjoint intervals add within a group and groups stay separate", () => {
  expect(reconcileIntervals([
    [{ start: 0, end: 1_000 }, { start: 2_000, end: 3_000 }],
    [{ start: 0, end: 5_000 }],
  ])).toEqual([2_000, 5_000]);
});

test("an empty group is zero rather than missing", () => {
  expect(reconcileIntervals([[], [{ start: 10, end: 20 }]])).toEqual([0, 10]);
});

test("invalid bounds are rejected before the policy sees them", () => {
  expect(() => reconcileIntervals([[{ start: 20, end: 10 }]])).toThrow("Invalid interval bounds");
});
