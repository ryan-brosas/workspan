/**
 * Inherited from ryan-brosas/pi-time-tracker at 931c74c024a24ae7800a66fe21bccecbf19a945b (MIT).
 * Upstream sha256 80d82538177efef80f0172321e5c66f759e09a5d057ca3b72463e8f37a38f186.
 * See docs/provenance.md: this copy is the successor implementation.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Interval, TimeRecord, TurnChunk } from "./ledger.ts";
type BendMaybe = { $: "Some"; value: string } | { $: "None" };
type BendPolicy = { evaluateIntervals(text: string): BendMaybe; evaluateAudit(text: string): BendMaybe };
let generatedPolicy: BendPolicy | undefined;

function loadGeneratedPolicy(): BendPolicy {
  try {
    generatedPolicy ??= createRequire(import.meta.url)("./generated/policy.mjs") as BendPolicy;
    return generatedPolicy;
  } catch (error) {
    throw new Error(`Unable to load generated Bend policy; rebuild with bun run build:bend or reinstall the package: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface NativeOptions { bendExecutable?: string; nativeExecutable?: string; cacheDir?: string }
const source = join(dirname(fileURLToPath(import.meta.url)), "engine.bend");
const MAX_INPUT_BYTES = 8 * 1024 * 1024 - 1;
const NAT_MAX = 2 ** 48 - 1;
const isNat = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= NAT_MAX;

export function nativeExecutable(options: NativeOptions = {}): string {
  const override = options.nativeExecutable ?? process.env.WORKTIME_BEND_BINARY;
  if (override) return override;
  const compiler = options.bendExecutable ?? process.env.BEND_EXECUTABLE ?? "bend";
  const digest = createHash("sha256").update(compiler);
  // Imported policy modules must invalidate the binary too, not just main.
  for (const name of readdirSync(dirname(source)).filter(n => n.endsWith(".bend")).sort()) digest.update(name).update("\0").update(readFileSync(join(dirname(source), name))).update("\0");
  const hash = digest.digest("hex").slice(0, 20);
  const cache = options.cacheDir ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pi-worktime-native");
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  const target = join(cache, `intervals-${hash}`);
  if (!existsSync(target)) {
    const pending = `${target}-${randomUUID()}`;
    try {
      const build = spawnSync(compiler, [source, "-o", pending], { encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024, env: { ...process.env, BEND_NO_TELEMETRY: "1" } });
      if (build.error || build.status !== 0 || !existsSync(pending)) throw new Error(`Bend engine build failed: ${build.error?.message ?? build.stderr.slice(-1000)}`);
      renameSync(pending, target);
    } finally { rmSync(pending, { force: true }); }
  }
  return target;
}

/** A configured compiler or prebuilt binary is an explicit request for the native lane. */
function usesNative(options: NativeOptions): boolean {
  const override = options.nativeExecutable ?? process.env.WORKTIME_BEND_BINARY;
  return Boolean(override || options.bendExecutable || process.env.BEND_EXECUTABLE);
}

function runNative(input: string, options: NativeOptions, audit = false): string {
  const binary = nativeExecutable(options);
  const temp = mkdtempSync(join(tmpdir(), "pi-worktime-native-"));
  try {
    const path = join(temp, "input.txt");
    writeFileSync(path, input, { mode: 0o600 });
    const result = spawnSync(binary, ["--threads", "1", "--", path, ...(audit ? ["audit"] : [])], { encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(`Bend reconciliation failed: ${result.error?.message ?? result.stderr.slice(-1000)}`);
    return result.stdout;
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

/** Which accounting runtime the given options select; reports state it for transparency. */
export function engineLabel(options: NativeOptions = {}): string {
  return usesNative(options) ? "native Bend" : "generated Bend policy";
}

/** Generated from the same Bend sources; no compiler, Bun or subprocess at runtime. */
function runGenerated(input: string, audit: boolean): string {
  let result: unknown;
  try {
    const policy = loadGeneratedPolicy();
    result = audit ? policy.evaluateAudit(input) : policy.evaluateIntervals(input);
  }
  catch (error) { throw new Error(`Generated Bend policy evaluation failed: ${error instanceof Error ? error.message : String(error)}; rebuild with bun run build:bend`); }
  if (result === null || typeof result !== "object" || !("$" in result)) throw new Error("Invalid Bend policy response");
  const outcome = result as { $: string; value?: unknown };
  if (outcome.$ === "None") throw new Error(audit ? "Invalid receipt audit batch" : "Invalid interval batch");
  if (outcome.$ !== "Some" || typeof outcome.value !== "string") throw new Error("Invalid Bend policy response");
  return outcome.value;
}

function runBatch(rows: string[], options: NativeOptions, audit = false): string[] {
  const input = rows.join("\n");
  if (Buffer.byteLength(input) > MAX_INPUT_BYTES) throw new Error(`${audit ? "Receipt audit" : "Interval"} batch exceeds the 8 MiB limit`);
  const text = usesNative(options) ? runNative(input, options, audit) : runGenerated(input, audit);
  const [header, ...lines] = text.trim().split("\n");
  if (header !== (audit ? "worktime-audit-v1" : "worktime-v1")) throw new Error("Invalid Bend response protocol; rebuild the generated policy or a stale prebuilt engine");
  return lines;
}

/** Bend owns sorting and interval union. JS validates transport and renders dates. */
export function reconcileIntervals(groups: readonly (readonly Interval[])[], options: NativeOptions = {}): number[] {
  const rows: string[] = [];
  for (const [group, intervals] of groups.entries()) for (const { start, end } of intervals) {
    if (!isNat(start) || !isNat(end) || end < start) throw new Error("Invalid interval bounds");
    rows.push(`${group},${start},${end}`);
  }
  if (!rows.length) return groups.map(() => 0);
  const totals = groups.map(() => 0), seen = new Set<number>();
  for (const line of runBatch(rows, options)) {
    if (!/^\d+,\d+$/.test(line)) throw new Error("Invalid Bend total row");
    const [id, total] = line.split(",").map(Number);
    if (!isNat(id) || id >= groups.length || seen.has(id) || !isNat(total)) throw new Error("Invalid Bend total value");
    seen.add(id); totals[id] = total;
  }
  for (const [id, intervals] of groups.entries()) if (intervals.length && !seen.has(id)) throw new Error("Bend response omitted a group");
  return totals;
}

const auditStatuses = ["consistent", "legacy", "missing", "checkpoint-only", "mismatch", "conflict"] as const;
export interface ReceiptAudit { status: typeof auditStatuses[number]; durableMs: number; summaryCopies: number }

/** Prepare numeric receipts; classification and conflict policy execute in audit.bend. */
export function auditTurnReceipts(turns: readonly TimeRecord[], chunks: readonly TurnChunk[], options: NativeOptions = {}): Map<string, ReceiptAudit> {
  if (new Set([...turns.map(t => t.scope), ...chunks.map(c => c.scope)]).size > 1) throw new Error("Receipt audit requires one turn scope");
  const ids = [...new Set([...turns.map(t => t.id), ...chunks.map(c => c.turnId)])];
  if (!ids.length) return new Map();
  const indices = new Map(ids.map((id, i) => [id, i]));
  const groups: Interval[][] = ids.map(() => []), summaries: TimeRecord[][] = ids.map(() => []);
  for (const t of turns) summaries[indices.get(t.id)!].push(t);
  for (const c of chunks) groups[indices.get(c.turnId)!].push({ start: Date.parse(c.start), end: Date.parse(c.end) });
  const totals = reconcileIntervals(groups, options), rows: string[] = [];
  const variants = new Map<string, number>();
  for (const [group, records] of summaries.entries()) {
    if (!records.length) rows.push(`${group},${totals[group]},${groups[group].length},0,0,0,0`);
    for (const t of records) {
      if (!isNat(t.observedMs)) throw new Error("Invalid receipt duration");
      // Intern exact normalized metadata, not a collision-prone hash. No text goes to Bend.
      const identity = JSON.stringify([t.startedAt, t.endedAt, t.observedMs, t.outcome, t.intervalVersion ?? null, t.label ?? null, t.labelSource ?? null, t.sessionId ?? null]);
      let variant = variants.get(identity);
      if (variant === undefined) { variant = variants.size; variants.set(identity, variant); }
      rows.push(`${group},${totals[group]},${groups[group].length},1,${t.observedMs},${t.intervalVersion === 2 ? 1 : 0},${variant}`);
    }
  }
  const result = new Map<string, ReceiptAudit>();
  for (const line of runBatch(rows, options, true)) {
    if (!/^\d+,\d+,\d+,\d+$/.test(line)) throw new Error("Invalid Bend audit row");
    const [group, status, durableMs, summaryCopies] = line.split(",").map(Number);
    if (![group, status, durableMs, summaryCopies].every(isNat) || group >= ids.length || status >= auditStatuses.length || result.has(ids[group]) || durableMs !== totals[group] || summaryCopies !== summaries[group].length) throw new Error("Invalid Bend audit value");
    result.set(ids[group], { status: auditStatuses[status], durableMs, summaryCopies });
  }
  if (result.size !== ids.length) throw new Error("Bend audit omitted a receipt group");
  return result;
}
