import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDotPresence } from "../src/cli/signals.ts";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function stateFile(value: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "dot-signals-"));
  roots.push(root);
  const path = join(root, "state.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

test("the latest Dot activity wins, in either epoch unit", () => {
  const ms = 1_791_054_618_000;
  const path = stateFile({ "electron-persisted-atom-state": {
    "aeon-last-activity-v1:profile-a": ms - 3_600_000,
    "aeon-last-activity-v1:profile-b": ms,
    "aeon-last-activity-fallback-v1:profile-c": ms + 3_600_000,
    "thread-user-activity-times-v1": { x: ms + 7_200_000 },
    "unrelated": ms + 9_000_000
  } });
  expect(readDotPresence(path)).toEqual({ available: true, last_activity_at: ms });
  expect(readDotPresence(stateFile({ "electron-persisted-atom-state": { "aeon-last-activity-v1:x": 1_791_054_618 } })))
    .toEqual({ available: true, last_activity_at: 1_791_054_618_000 });
  expect(readDotPresence(stateFile({ "electron-persisted-atom-state": { "aeon-last-activity-v1:y": { at: 1_791_054_618_000 } } })))
    .toEqual({ available: true, last_activity_at: 1_791_054_618_000 });
});

test("a missing file, bad JSON or no Dot keys is unavailable, never zero", () => {
  expect(readDotPresence(join(tmpdir(), "definitely-not-there-9f8a", "state.json"))).toEqual({ available: false, last_activity_at: null });
  const broken = mkdtempSync(join(tmpdir(), "dot-broken-"));
  roots.push(broken);
  const brokenPath = join(broken, "state.json");
  writeFileSync(brokenPath, "{not json");
  expect(readDotPresence(brokenPath)).toEqual({ available: false, last_activity_at: null });
  expect(readDotPresence(stateFile({ "electron-persisted-atom-state": { other: 1 } }))).toEqual({ available: false, last_activity_at: null });
  expect(readDotPresence(stateFile({}))).toEqual({ available: false, last_activity_at: null });
});
