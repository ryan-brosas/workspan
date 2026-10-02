import { expect, test } from "bun:test";
import { appendFileSync, chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPinnedCompiler, getBendEnv, resolveBendExecutable, resolveBendSource, toolchain } from "../scripts/bend-toolchain.mjs";

/** Inherited from pi-time-tracker; the sources live in src/core here. */
const root = join(import.meta.dir, "..");
const generatedDir = join("src", "core", "generated");

/** An isolated copy of the build inputs, so drift checks never rewrite the repository. */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "workspan-build-"));
  try {
    mkdirSync(join(dir, "scripts"));
    mkdirSync(join(dir, "src", "core"), { recursive: true });
    for (const file of ["engine.bend", "audit.bend", "batch.bend"]) copyFileSync(join(root, "src", "core", file), join(dir, "src", "core", file));
    for (const file of ["build-bend.mjs", "bend-toolchain.mjs", "bend-toolchain.json", "bend-entry.ts"]) copyFileSync(join(root, "scripts", file), join(dir, "scripts", file));
    cpSync(join(root, generatedDir), join(dir, generatedDir), { recursive: true });
    return dir;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

// The emitter ships only inside the pinned toolchain; say so instead of passing vacuously.
const buildToolchain = (() => {
  try { return { bend: resolveBendExecutable(), source: resolveBendSource() }; } catch (error) {
    if (error instanceof Error && error.message.startsWith("No Bend compiler found.")) return null;
    throw error;
  }
})();
const requiresToolchain = buildToolchain === null
  ? "the pinned Bend build toolchain is not installed (run scripts/install-bend-ci.sh or set BEND_SOURCE_DIR)"
  : null;

const check = (dir: string) => Bun.spawnSync([process.execPath, "scripts/build-bend.mjs", "--check"], {
  cwd: dir,
  env: { ...getBendEnv(), BEND_EXECUTABLE: buildToolchain?.bend, BEND_SOURCE_DIR: buildToolchain?.source },
});
const expectSuccess = (result: ReturnType<typeof check>) => expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);

test.skipIf(process.platform === "win32")("compiler environment and pinned version checks use current exact values", () => {
  const original = process.env.BEND_SOURCE_DIR;
  process.env.BEND_SOURCE_DIR = "/late/environment/value";
  try { expect(getBendEnv().BEND_SOURCE_DIR).toBe("/late/environment/value"); }
  finally { if (original === undefined) delete process.env.BEND_SOURCE_DIR; else process.env.BEND_SOURCE_DIR = original; }

  const dir = mkdtempSync(join(tmpdir(), "workspan-bend-version-"));
  const executable = join(dir, "bend");
  const writeVersion = (body: string) => { writeFileSync(executable, `#!/bin/sh\n${body}\n`); chmodSync(executable, 0o755); };
  try {
    writeVersion(`echo 'Bend ${toolchain.version}'`);
    expect(assertPinnedCompiler(executable)).toBe(executable);
    writeVersion(`echo 'Bend ${toolchain.version}0'`);
    expect(() => assertPinnedCompiler(executable)).toThrow();
    writeVersion(`echo 'Bend ${toolchain.version}-dev'`);
    expect(() => assertPinnedCompiler(executable)).toThrow();
    writeVersion('echo compiler-error >&2; exit 7');
    expect(() => assertPinnedCompiler(executable)).toThrow(/exit 7/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 10_000);

test.skipIf(buildToolchain === null)(requiresToolchain ?? "the committed generated policy matches its Bend sources", () => {
  const result = check(root);
  expect(result.stdout.toString() + result.stderr.toString()).toContain("generated policy is current");
  expectSuccess(result);
}, 120_000);

test.skipIf(buildToolchain === null)(requiresToolchain ?? "drifted or missing generated policy fails the build gate", () => {
  const dir = fixture();
  try {
    expectSuccess(check(dir));
    appendFileSync(join(dir, generatedDir, "policy.mjs"), "\n// hand edit\n");
    const drifted = check(dir);
    expect(drifted.exitCode, drifted.stdout.toString() + drifted.stderr.toString()).not.toBe(0);
    expect(drifted.stderr.toString()).toContain("missing or stale");
    rmSync(join(dir, generatedDir, "policy.mjs"));
    const missing = check(dir);
    expect(missing.exitCode, missing.stdout.toString() + missing.stderr.toString()).not.toBe(0);
    expect(missing.stderr.toString()).toContain("missing or stale");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 180_000);
