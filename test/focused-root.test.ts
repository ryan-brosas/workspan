import { expect, test } from "bun:test";
import { join } from "node:path";
import { cwdOf, descendantRoots, herdrForegroundCwd, majorityRoot, pickForegroundCwd, plausibleCwd } from "../src/cli/focused-root.ts";
import { repositoryRoot } from "../src/core/workspace.ts";

test("the foreground pane is the only cwd that counts", () => {
  expect(pickForegroundCwd(undefined)).toBeNull();
  expect(pickForegroundCwd([{ cwd: "/some/dir" }, { foreground_cwd: "", cwd: "/other" }])).toBeNull();
  expect(pickForegroundCwd([{ foreground_cwd: "  ", cwd: "/x" }])).toBeNull();
  expect(pickForegroundCwd([{ cwd: "/a" }, { foreground_cwd: "/mnt/ssd/work/project/workspan", cwd: "/a" }]))
    .toBe("/mnt/ssd/work/project/workspan");
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
