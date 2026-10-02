// One source of truth for the pinned Bend toolchain used by builds, proofs and CI.
// The runtime package never needs it: generated/policy.mjs is committed.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const toolchain = JSON.parse(readFileSync(join(root, "scripts", "bend-toolchain.json"), "utf8"));

/** Telemetry and self-update stay off for every compiler invocation. */
export function getBendEnv() { return { ...process.env, BEND_NO_TELEMETRY: "1", BEND_NO_UPDATE: "1" }; }

export function resolveBendExecutable() {
  const override = process.env.BEND_EXECUTABLE;
  if (override) return override;
  const found = Bun.which("bend");
  if (!found) throw new Error("No Bend compiler found. Set BEND_EXECUTABLE or put bend on PATH.");
  return found;
}

/** The build-time source of the pinned release; the released binary has no JS emitter. */
export function resolveBendSource() {
  const override = process.env.BEND_SOURCE_DIR;
  const candidate = override ?? join(dirname(resolveBendExecutable()), "..", "source");
  const main = join(candidate, "bend2", "main.ts");
  if (!existsSync(main)) throw new Error(`Bend build source is missing at ${main}. Run scripts/install-bend-ci.sh or set BEND_SOURCE_DIR.`);
  return candidate;
}

/** Fail fast when the compiler on PATH is not the pinned release. */
export function assertPinnedCompiler(bend) {
  const result = Bun.spawnSync([bend, "version"], { env: getBendEnv() });
  const text = result.stdout.toString() + result.stderr.toString();
  if (result.exitCode !== 0) throw new Error(`Bend version command failed (exit ${result.exitCode}): ${text.trim()}`);
  const versionPattern = new RegExp(`(^|[^A-Za-z0-9.+-])v?${toolchain.version.replaceAll(".", "\\.")}($|[^A-Za-z0-9.+-])`);
  if (!versionPattern.test(text)) throw new Error(`Bend ${toolchain.version} is required, found: ${text.trim()}`);
  return bend;
}
