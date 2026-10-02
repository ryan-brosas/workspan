/**
 * What is actually computing the numbers.
 *
 * Bend owns interval union and receipt classification, and the running artifact is
 * the generated one unless the native lane is explicitly selected. Nothing about
 * that was visible anywhere, so the daemon reports it and can re-probe it live:
 * "an explicitly selected engine failure must remain visible" is a requirement,
 * not a nicety.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { engineLabel, reconcileIntervals, type NativeOptions } from "../core/native.ts";

const coreDir = join(dirname(fileURLToPath(import.meta.url)), "..", "core");
const artifactDir = join(coreDir, "generated");
const artifactPath = join(artifactDir, "policy.mjs");

/** Overlapping halves: the union is 2000ms, while adding them would give 2500ms. */
export const ENGINE_PROBE: ReadonlyArray<{ start: number; end: number }> = [{ start: 0, end: 1_000 }, { start: 500, end: 2_000 }];
export const ENGINE_PROBE_EXPECTED = 2_000;

export interface EngineInfo {
  /** "generated Bend policy" by default, "native Bend" only when explicitly selected. */
  label: string;
  /** True when the native lane is selected, where a failure must not fall back silently. */
  native: boolean;
  /** sha256 of the artifact that is loaded, so a stale or swapped policy is visible. */
  digest: string | null;
  bytes: number | null;
  /** Compiler version the artifact was generated with, read from its own header. */
  version: string | null;
  /** The Bend sources the artifact is generated from, present on disk. */
  sources: string[];
  /** Proof obligations that live beside the sources and gate changes to them. */
  proofs: string[];
  artifact: string;
}

/** What `scripts/bend-entry.ts` actually imports, directly or transitively. */
const POLICY_SOURCES = ["engine.bend", "batch.bend", "audit.bend"];
/** Laws and their witnesses: not part of the artifact, but they gate it. */
const PROOF_SOURCES = ["LAWS.bend", "PROOF.bend"];

function present(names: readonly string[]): string[] {
  try {
    const onDisk = new Set(readdirSync(coreDir));
    return names.filter(name => onDisk.has(name)).sort();
  } catch { return []; }
}

function artifactVersion(text: string): string | null {
  const match = text.match(/with Bend ([0-9]+\.[0-9]+\.[0-9]+)/);
  return match ? match[1] : null;
}

export function engineInfo(options: NativeOptions = {}): EngineInfo {
  let text = "";
  let digest: string | null = null;
  try {
    text = readFileSync(artifactPath, "utf8");
    digest = createHash("sha256").update(text).digest("hex");
  } catch { /* a missing artifact stays visible as null rather than being hidden */ }
  const label = engineLabel(options);
  return {
    label,
    native: label !== "generated Bend policy",
    digest,
    bytes: text ? Buffer.byteLength(text) : null,
    version: text ? artifactVersion(text) : null,
    sources: present(POLICY_SOURCES),
    proofs: present(PROOF_SOURCES),
    artifact: artifactPath,
  };
}

/** Run the probe through the real host caller, not a second implementation. */
export function probeEngine(options: NativeOptions = {}): { ok: boolean; expected: number; reported: number; label: string } {
  const reported = reconcileIntervals([ENGINE_PROBE.map(interval => ({ ...interval }))], options)[0];
  return { ok: reported === ENGINE_PROBE_EXPECTED, expected: ENGINE_PROBE_EXPECTED, reported, label: engineLabel(options) };
}
