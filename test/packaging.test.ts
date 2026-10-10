import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The package, the plugin manifest and the release tag must not drift apart. */
test("the plugin manifest version matches the package version", () => {
  const root = join(import.meta.dir, "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
  const manifest = JSON.parse(readFileSync(join(root, "plugin", "manifest.json"), "utf8")) as { version?: unknown };
  expect(typeof pkg.version).toBe("string");
  expect(manifest.version).toBe(pkg.version);
});

/** The installer must reach a task-owned HOME and report every outcome by status. */
const repoRoot = join(import.meta.dir, "..");
const INSTALLED = join(".config", "omarchy", "plugins", "workspan.tracker");
const installerFiles = ["manifest.json", "Panel.qml", "SessionControls.qml", "Draft.js", "Workspan.js", "README.md"];
const scratch = mkdtempSync(join(tmpdir(), "workspan-install-plugin-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Run the installer with HOME/XDG_STATE_HOME pointed at a throwaway dir, so no
 *  live widget, backup directory or shell config is read or written. */
function installIn(home: string, ...args: string[]): number {
  const result = spawnSync("bash", [join(repoRoot, "scripts", "install-plugin.sh"), ...args], {
    cwd: repoRoot,
    env: { ...process.env, HOME: home, XDG_STATE_HOME: join(home, ".local", "state") },
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return result.status ?? -1;
}

/** A release-shaped ZIP whose workspan.tracker/ holds exactly the named plugin files. */
function packageZip(zipPath: string, names: string[]): void {
  const stage = mkdtempSync(join(scratch, "stage-"));
  const dir = join(stage, "workspan.tracker");
  mkdirSync(dir, { recursive: true });
  for (const name of names) cpSync(join(repoRoot, "plugin", name), join(dir, name));
  const zipped = spawnSync("zip", ["-qr", zipPath, "workspan.tracker"], { cwd: stage, encoding: "utf8" });
  if (zipped.error) throw zipped.error;
  expect(zipped.status).toBe(0);
}

test("installing the source plugin succeeds and a matching verify-only also succeeds", () => {
  const home = mkdtempSync(join(scratch, "home-source-"));
  // A clean run with no --from leaves the cleanup work dir empty; that path must
  // still exit 0 rather than inherit the EXIT trap's failed test status.
  expect(installIn(home)).toBe(0);
  for (const name of installerFiles) expect(existsSync(join(home, INSTALLED, name))).toBe(true);
  expect(installIn(home, "--verify-only")).toBe(0);
});

test("a tampered installation fails verification", () => {
  const home = mkdtempSync(join(scratch, "home-tampered-"));
  expect(installIn(home)).toBe(0);
  writeFileSync(join(home, INSTALLED, "Panel.qml"), "// tampered\n");
  expect(installIn(home, "--verify-only")).not.toBe(0);
});

test("a released ZIP installs and verifies; a ZIP missing a plugin file is refused", () => {
  const good = join(scratch, "workspan.tracker-test.zip");
  packageZip(good, installerFiles);
  const home = mkdtempSync(join(scratch, "home-zip-"));
  expect(installIn(home, "--from", good)).toBe(0);
  expect(installIn(home, "--verify-only")).toBe(0);

  const bad = join(scratch, "workspan.tracker-bad.zip");
  packageZip(bad, installerFiles.filter(name => name !== "Draft.js"));
  const refused = mkdtempSync(join(scratch, "home-refused-"));
  expect(installIn(refused, "--from", bad)).toBe(2);
  expect(existsSync(join(refused, INSTALLED))).toBe(false);
});
