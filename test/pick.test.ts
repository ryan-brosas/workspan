import { expect, test } from "bun:test";
import { defaultRows, pickProject, type Binding } from "../src/cli/pick.ts";

const bindings: Binding[] = [
  { project: "coral-stuff", root: "/mnt/ssd/work/coral-stuff", explicit: false },
  { project: "workspan", root: "/mnt/ssd/work/project/workspan", explicit: false },
  { project: "beacon-brand-website", root: "/mnt/ssd/work/project/beacon-brand-website", explicit: false },
  { project: "coral-stuff", root: "/mnt/ssd/work/project/coral-bricks-site", explicit: false },
];

test("one row per company, its roots as subtext", () => {
  const rows = defaultRows(bindings);
  expect(rows).toEqual([
    "beacon-brand-website\u0009/mnt/ssd/work/project/beacon-brand-website",
    "coral-stuff\u0009/mnt/ssd/work/coral-stuff, /mnt/ssd/work/project/coral-bricks-site",
    "workspan\u0009/mnt/ssd/work/project/workspan",
  ]);
});

test("no bindings is a clear none, never a fabricated picker", () => {
  expect(pickProject([], { rows: defaultRows, select: () => null })).toEqual({ none: true });
});

test("a dismissed picker changes nothing", () => {
  expect(pickProject(bindings, { rows: defaultRows, select: () => null })).toEqual({ dismissed: true });
});

test("a selection returns the company, subtext stripped", () => {
  const picked = pickProject(bindings, { rows: defaultRows, select: (_prompt, input) => input.split("\n")[1]?.split("\u0009")[0] ?? null });
  expect(picked).toEqual({ project: "coral-stuff" });
});

test("a stale label from the picker surface is still checked against the bindings", () => {
  const picked = pickProject(bindings, { rows: defaultRows, select: () => "not-a-company" });
  expect(picked).toEqual({ dismissed: true });
});
