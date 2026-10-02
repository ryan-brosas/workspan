import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_PROBE, ENGINE_PROBE_EXPECTED, engineInfo, probeEngine } from "../src/daemon/engine.ts";

const coreDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "core");

test("the reported artifact is the one on disk, by digest", () => {
  const info = engineInfo();
  const bytes = readFileSync(join(coreDir, "generated", "policy.mjs"), "utf8");
  expect(info.digest).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(info.bytes).toBe(Buffer.byteLength(bytes));
  expect(info.artifact).toContain("src/core/generated/policy.mjs");
});

test("the artifact names the compiler that generated it, and the sources it came from", () => {
  const info = engineInfo();
  expect(info.version).toBe("2.0.31");
  // The policy sources are the ones the build entry imports; the proof files sit
  // beside them and gate changes without being part of the artifact.
  expect(info.sources).toEqual(["audit.bend", "batch.bend", "engine.bend"]);
  expect(info.proofs).toEqual(["LAWS.bend", "PROOF.bend"]);
  const onDisk = readdirSync(coreDir);
  for (const name of [...info.sources, ...info.proofs]) expect(onDisk).toContain(name);
});

test("the default lane is the generated policy, so no compiler is needed to report hours", () => {
  const info = engineInfo();
  expect(info.label).toBe("generated Bend policy");
  expect(info.native).toBe(false);
});

test("an explicitly selected native lane is reported as such, never hidden", () => {
  const info = engineInfo({ bendExecutable: "/nonexistent/bend" });
  expect(info.label).toBe("native Bend");
  expect(info.native).toBe(true);
});

test("the live probe runs through the real caller and would catch a broken union", () => {
  const probe = probeEngine();
  expect(probe.expected).toBe(ENGINE_PROBE_EXPECTED);
  // Overlapping halves union to 2000ms; adding them would be 2500ms.
  expect(probe.reported).toBe(2_000);
  expect(probe.ok).toBe(true);
  expect(probe.label).toBe("generated Bend policy");
});
