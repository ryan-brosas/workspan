import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBendEnv, resolveBendExecutable } from "../scripts/bend-toolchain.mjs";

/**
 * Inherited from pi-time-tracker. The laws and their proofs are copied policy
 * files, so a mutated variant never touches the repository.
 */
const coreDir = join(import.meta.dir, "..", "src", "core");

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "workspan-proof-"));
  for (const file of ["engine.bend", "audit.bend", "batch.bend", "LAWS.bend", "PROOF.bend"]) copyFileSync(join(coreDir, file), join(dir, file));
  return dir;
}
const prove = (dir: string) => Bun.spawnSync([resolveBendExecutable(), "PROOF.bend"], { cwd: dir, env: getBendEnv() });
const output = (result: Bun.SyncSubprocess) => (result.stdout?.toString() ?? "") + (result.stderr?.toString() ?? "");

test("every stated audit law is proven on the pinned compiler", () => {
  const dir = fixture();
  try {
    const result = prove(dir);
    expect(output(result)).toContain("All terms check.");
    expect(result.exitCode).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120_000);

test("a broken conflict implementation fails its law, not the syntax", () => {
  const dir = fixture();
  try {
    expect(prove(dir).exitCode).toBe(0);
    const audit = readFileSync(join(dir, "audit.bend"), "utf8");
    const mutated = audit.replace("    case True{}:\n      5n", "    case True{}:\n      0n");
    if (mutated === audit) throw new Error("mutation target not found in audit.bend");
    writeFileSync(join(dir, "audit.bend"), mutated);
    const broken = prove(dir);
    expect(broken.exitCode).not.toBe(0);
    expect(output(broken)).toContain("conflict_wins");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120_000);

test("a law without its proof is an open claim the gate rejects", () => {
  const dir = fixture();
  try {
    const proof = readFileSync(join(dir, "PROOF.bend"), "utf8");
    const mutated = proof.replace(/def Laws\.checkpoint_only\(intervals, total, expected, modern\):\n  \{==\}\n/, "");
    if (mutated === proof) throw new Error("mutation target not found in PROOF.bend");
    writeFileSync(join(dir, "PROOF.bend"), mutated);
    const missing = prove(dir);
    expect(missing.exitCode).not.toBe(0);
    // An unproven law is reported as an open claim, never as a syntax or tool error.
    expect(output(missing)).toContain("TODO found");
    expect(output(missing)).not.toContain("All terms check.");
    writeFileSync(join(dir, "PROOF.bend"), proof);
    expect(prove(dir).exitCode).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120_000);
