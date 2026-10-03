import { expect, test } from "bun:test";
import { join } from "node:path";
import { cwdOf, descendantRoots, herdrForegroundCwd, majorityRoot, pickForegroundCwd, plausibleCwd } from "../src/cli/focused-root.ts";
import { repositoryRoot } from "../src/core/workspace.ts";

test("the focused agent decides, never list order", () => {
  // A real Herdr payload gives every agent a foreground_cwd, so the flag is the
  // only discriminator - and the focused pane deliberately is not first.
  const agents = [
    { focused: false, cwd: "/mnt/ssd/work/project/beacon-brand-website", foreground_cwd: "/mnt/ssd/work/project/beacon-brand-website" },
    { focused: false, cwd: "/mnt/ssd/work/coral-stuff", foreground_cwd: "/mnt/ssd/work/coral-stuff" },
    { focused: true, cwd: "/mnt/ssd/work/project/workspan", foreground_cwd: "/mnt/ssd/work/project/workspan" },
  ];
  expect(pickForegroundCwd(agents)).toBe("/mnt/ssd/work/project/workspan");

  // The old shape - a lone foreground_cwd with nobody focused - is not a signal.
  expect(pickForegroundCwd([{ cwd: "/a" }, { foreground_cwd: "/mnt/ssd/work/project/workspan", cwd: "/a" }])).toBeNull();
  // Nothing focused: no answer from Herdr at all, and list order never guesses.
  expect(pickForegroundCwd(agents.map(agent => ({ ...agent, focused: false })))).toBeNull();

  // A focused pane without foreground_cwd still resolves through its cwd.
  expect(pickForegroundCwd([{ focused: true, cwd: "/mnt/ssd/work/project/workspan" }])).toBe("/mnt/ssd/work/project/workspan");
  // Blank or junk values are never a workspace.
  expect(pickForegroundCwd([{ focused: true, foreground_cwd: "  ", cwd: "" }])).toBeNull();
  expect(pickForegroundCwd([{ focused: true, foreground_cwd: "  ", cwd: "/x" }])).toBe("/x");
  expect(pickForegroundCwd(undefined)).toBeNull();
  expect(pickForegroundCwd([null, 42, "x"])).toBeNull();
});

test("process plumbing is never a workspace", () => {
  expect(plausibleCwd("/mnt/ssd/work/project/workspan")).toBe(true);
  expect(plausibleCwd("/home/utopia")).toBe(true);
  expect(plausibleCwd("/")).toBe(false);
  expect(plausibleCwd("/proc/2302540/fdinfo")).toBe(false);
  expect(plausibleCwd("/proc")).toBe(false);
  expect(plausibleCwd("/run/user/1000")).toBe(false);
  expect(plausibleCwd("/sys/fs/cgroup")).toBe(false);
  expect(plausibleCwd("/dev/null")).toBe(false);
});

test("a tie in the process tree keeps the first root seen", () => {
  expect(majorityRoot([])).toBeNull();
  expect(majorityRoot(["/a", "/b"])).toBe("/a");
  expect(majorityRoot(["/a", "/b", "/a"])).toBe("/a");
});

test("a real process tree resolves to its own repository", () => {
  // This test process runs inside the workspan repository: its own tree is the
  // honest fixture for the walk.
  const expected = repositoryRoot(process.cwd());
  expect(cwdOf(process.pid)).not.toBeNull();
  expect(majorityRoot(descendantRoots(process.pid))).toBe(expected);
});

test("an absent herdr answers null, never a guess", async () => {
  await expect(herdrForegroundCwd(join("/nonexistent", "herdr.sock"))).resolves.toBeNull();
});
