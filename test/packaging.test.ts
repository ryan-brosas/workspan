import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

/** The package, the plugin manifest and the release tag must not drift apart. */
test("the plugin manifest version matches the package version", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version?: unknown };
  const manifest = JSON.parse(readFileSync(join(repoRoot, "plugin", "manifest.json"), "utf8")) as { version?: unknown };
  expect(typeof pkg.version).toBe("string");
  expect(manifest.version).toBe(pkg.version);
});

/** The installer must reach a task-owned HOME and report every outcome by status. */
const INSTALLED = join(".config", "omarchy", "plugins", "workspan.tracker");
// Top-level plugin files are the package; the tests/ directory is not shipped.
const installerFiles = readdirSync(join(repoRoot, "plugin"), { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name).sort();

test("the release copy list covers every plugin file", () => {
  const release = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8");
  const line = release.split("\n").find(line => /^\s*cp plugin\//.test(line));
  expect(line).toBeDefined();
  const copied = [...line!.matchAll(/plugin\/([^\s]+)/g)].map(match => match[1]).sort();
  expect(copied).toEqual(installerFiles);
});
const scratch = mkdtempSync(join(tmpdir(), "workspan-install-plugin-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The output of the most recent installIn run, attached to the next assertion
 *  so a failing status shows the installer's own message. */
let lastInstallOutput = "";

/** Run the installer with HOME and every XDG base directory pointed at a
 *  throwaway dir, so no live widget, backup directory or shell config is read or
 *  written - even an installer that honors the XDG spec. */
function installIn(home: string, ...args: string[]): number {
  const result = spawnSync("bash", [join(repoRoot, "scripts", "install-plugin.sh"), ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      XDG_STATE_HOME: join(home, ".local", "state"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_CACHE_HOME: join(home, ".cache"),
    },
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  lastInstallOutput = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return result.status ?? -1;
}

/** The installer's ZIP path already depends on a host unzip; the test builds
 *  the archive with the matching host zip. Probe that prerequisite once, so a
 *  machine without it gets a named message instead of an opaque spawn ENOENT. */
const hasZip = spawnSync("zip", ["-v"], { stdio: "ignore", timeout: 5_000 }).status === 0;

/** A release-shaped ZIP whose workspan.tracker/ holds exactly the named plugin
 *  files, built with host zip and read back by the installer's own unzip. */
function packageZip(zipPath: string, names: string[]): void {
  const dir = mkdtempSync(join(scratch, "zip-src-"));
  const pkgDir = join(dir, "workspan.tracker");
  mkdirSync(pkgDir);
  for (const name of names) copyFileSync(join(repoRoot, "plugin", name), join(pkgDir, name));
  const zipped = spawnSync("zip", ["-q", "-r", zipPath, "workspan.tracker"], { cwd: dir, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
  if (zipped.error) throw zipped.error;
  if (zipped.status !== 0) throw new Error("zip failed (" + zipped.status + "): " + (zipped.stderr ?? ""));
}

test("installing the source plugin succeeds and a matching verify-only also succeeds", () => {
  const home = mkdtempSync(join(scratch, "home-source-"));
  // A clean run with no --from leaves the cleanup work dir empty; that path must
  // still exit 0 rather than inherit the EXIT trap's failed test status.
  expect(installIn(home), lastInstallOutput).toBe(0);
  for (const name of installerFiles) expect(existsSync(join(home, INSTALLED, name))).toBe(true);
  expect(installIn(home, "--verify-only"), lastInstallOutput).toBe(0);
});

test("a tampered installation fails verification", () => {
  const home = mkdtempSync(join(scratch, "home-tampered-"));
  expect(installIn(home), lastInstallOutput).toBe(0);
  writeFileSync(join(home, INSTALLED, "Panel.qml"), "// tampered\n");
  expect(installIn(home, "--verify-only"), lastInstallOutput).not.toBe(0);
});

test("a released ZIP installs and verifies; a ZIP missing a plugin file is refused", () => {
  if (!hasZip) throw new Error("the ZIP install path needs the host zip binary to build its fixture; install zip (e.g. pacman -S zip)");
  const good = join(scratch, "workspan.tracker-test.zip");
  packageZip(good, installerFiles);
  const home = mkdtempSync(join(scratch, "home-zip-"));
  expect(installIn(home, "--from", good), lastInstallOutput).toBe(0);
  expect(installIn(home, "--verify-only"), lastInstallOutput).toBe(0);

  const bad = join(scratch, "workspan.tracker-bad.zip");
  packageZip(bad, installerFiles.filter(name => name !== "Draft.js"));
  const refused = mkdtempSync(join(scratch, "home-refused-"));
  expect(installIn(refused, "--from", bad), lastInstallOutput).toBe(2);
  expect(existsSync(join(refused, INSTALLED))).toBe(false);
});
