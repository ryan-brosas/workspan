import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, compareVersions, latestVersion, nextVersion, releaseState, stampVersion } from "../scripts/release-version.ts";

test("the release level follows Conventional Commits", () => {
  expect(classify(["feat: something"])).toBe("minor");
  expect(classify(["fix: something"])).toBe("patch");
  expect(classify(["docs: something", "chore: tidy"])).toBe("patch");
  expect(classify(["fix: small", "feat: bigger"])).toBe("minor");
  expect(classify(["feat!: breaking"])).toBe("major");
  expect(classify(["fix(core)!: breaking"])).toBe("major");
  // A chore is still a change to the released tree, so it clears the release bar at patch;
  // a bump commit itself never does.
  expect(classify(["chore: release only", "chore(release): v0.2.0"])).toBe("patch");
  expect(classify(["chore(release): v0.2.0"])).toBe("none");
  expect(classify([])).toBe("none");
});

test("the next version is derived from the current one, never guessed", () => {
  expect(nextVersion("0.1.0", "patch")).toBe("0.1.1");
  expect(nextVersion("0.1.0", "minor")).toBe("0.2.0");
  expect(nextVersion("0.1.0", "major")).toBe("1.0.0");
  expect(nextVersion("1.4.9", "patch")).toBe("1.4.10");
  expect(nextVersion("0.1.0", "none")).toBeNull();
  expect(nextVersion("0.1.0", "patch", "v0.9.0")).toBe("0.9.0");
  // A prerelease that gains real changes is finalized before anything else moves on.
  expect(nextVersion("0.2.0-rc.1", "patch")).toBe("0.2.0");
  expect(nextVersion("0.2.0-rc.1", "prerelease")).toBe("0.2.0-rc.2");
  expect(nextVersion("0.2.0", "prerelease")).toBe("0.2.1-rc.1");
});

test("a tree with nothing since its last tag has nothing to release", () => {
  // The state the workflow reads: no commits after the tag means no version, and an
  // explicit version is still honoured when a human asks for one.
  const idle = releaseState({ lastTag: "" });
  expect(idle.level).toBe("none");
  expect(idle.version).toBeNull();
  expect(releaseState({ lastTag: "", explicit: "1.0.0" }).version).toBe("1.0.0");
});

test("stamping a version the files already state is a no-op, never an error", () => {
  // The recovery path after a partial failure: the tree is bumped but the tag is
  // missing, so the same run must be able to repeat itself.
  const dir = mkdtempSync(join(tmpdir(), "ws-stamp-"));
  const file = (name: string, text: string) => { const path = join(dir, name); writeFileSync(path, text); return { path, stamp: (value: string, version: string) => value.replace(/"version": "[^"]+"/, `"version": "${version}"`) }; };
  const files = [file("a.json", '{ "version": "1.2.3" }'), file("b.json", '{ "version": "1.2.2" }')];
  try {
    expect(stampVersion("1.2.3", files)).toEqual([join(dir, "b.json")]);
    expect(readFileSync(files[0]!.path, "utf8")).toContain('"version": "1.2.3"');
    expect(readFileSync(files[1]!.path, "utf8")).toContain('"version": "1.2.3"');
    // Repeating the same stamp changes nothing and still does not throw.
    expect(stampVersion("1.2.3", files)).toEqual([]);
    // A file that carries no version at all is still a failure.
    expect(() => stampVersion("2.0.0", [file("c.json", "{}")])).toThrow("does not carry a version");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tag ordering understands prereleases", () => {
  expect(compareVersions("v0.1.0-rc.1", "v0.1.0")).toBeLessThan(0);
  expect(compareVersions("v0.1.0", "v0.1.0-rc.1")).toBeGreaterThan(0);
  expect(compareVersions("v0.10.0", "v0.9.0")).toBeGreaterThan(0);
  expect(latestVersion(["v0.1.0", "v0.1.0-rc.1", "not-a-tag", "v0.2.0"])).toBe("0.2.0");
  expect(latestVersion(["notes"])).toBeNull();
});
