/** Shared IPC transport and durable evidence delivery, imported by both the client and the daemon so neither owns the other. */
import { connect } from "node:net";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { encodeFrame, MAX_FRAME_BYTES, parseResponse, PROTOCOL_VERSION, type Method } from "./protocol.ts";
import { socketPath as socketPathFor } from "./daemon/paths.ts";
import { EVIDENCE_VERSION, eventId, validateEvent, type EvidenceEvent } from "./daemon/evidence.ts";

export const DEFAULT_TIMEOUT_MS = 5_000;
export const MAX_SPOOL_BYTES = 10 * 1024 * 1024;
export interface RequestOptions { socketPath?: string; timeoutMs?: number; id?: string }
export function defaultSocketPath(): string { return socketPathFor(); }

export function request(method: Method, params?: unknown, options: RequestOptions = {}): Promise<unknown> {
  const frame = encodeFrame({ v: PROTOCOL_VERSION, id: options.id ?? `c-${randomUUID()}`, method, params });
  if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) return Promise.reject(new Error("frame_too_large: request exceeds the frame limit"));
  const socketFile = options.socketPath ?? defaultSocketPath();
  return new Promise((resolve, reject) => {
    const client = connect(socketFile);
    client.setEncoding("utf8");
    let buffer = "", done = false;
    const fail = (message: string) => { done = true; client.destroy(); reject(new Error(message)); };
    client.setTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    client.on("connect", () => client.write(frame));
    client.on("data", chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) { fail("frame_too_large: response exceeds the frame limit"); return; }
      const index = buffer.indexOf("\n");
      if (index === -1) return;
      try {
        const response = parseResponse(buffer.slice(0, index));
        done = true;
        client.destroy();
        if (response.ok) resolve(response.result);
        else reject(new Error(`${response.error.code}: ${response.error.message}`));
      } catch { fail("bad_response: invalid daemon response"); }
    });
    client.on("end", () => { if (!done) fail("bad_response: daemon closed before acknowledgement"); });
    client.on("timeout", () => fail(`daemon not responding at ${socketFile}`));
    client.on("error", error => fail(`cannot reach the Workspan daemon at ${socketFile} (${(error as NodeJS.ErrnoException).code ?? "error"}); start it with: workspan daemon`));
  });
}

/**
 * Batch bounds. A batch stays far below MAX_FRAME_BYTES (64 KiB) once the request
 * envelope is added, so `frame_too_large` cannot reject a batch built here, and
 * validateEvent bounds every field to 128 characters, so a spooled record is roughly
 * 1.5 KB. These bounds shape batches; they never refuse a record the spool accepted.
 */
export const MAX_BATCH_BYTES = 24_000;
export const MAX_BATCH_EVENTS = 100;
/** Input AND acknowledgement remain below the frame limit, including UTF-8 identities. */
export function batchEvidence(events: readonly unknown[]): unknown[][] {
  const batches: unknown[][] = [];
  let current: unknown[] = [], bytes = 0;
  for (const event of events) {
    const size = Buffer.byteLength(JSON.stringify(event)) + 1;
    if (size > MAX_BATCH_BYTES) throw new Error("event_too_large: evidence exceeds the batch limit");
    if (current.length >= MAX_BATCH_EVENTS || bytes + size > MAX_BATCH_BYTES) { batches.push(current); current = []; bytes = 0; }
    current.push(event); bytes += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

/** Whether one record fits any batch at all; false means permanently undeliverable, not retryable. */
export function eventFitsBatch(event: unknown): boolean {
  return Buffer.byteLength(JSON.stringify(event)) + 1 <= MAX_BATCH_BYTES;
}

export function spoolDirectory(): string {
  return process.env.WORKSPAN_SPOOL_DIR ?? join(process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? "/tmp", ".local", "state"), "workspan");
}
export interface SpoolOptions { spoolPath: string; socketPath?: string; maxBytes?: number; onFull?: (message: string) => void; retryIntervalMs?: number }

function size(path: string): number { try { return lstatSync(path).size; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; } }
/**
 * Make a directory entry durable: contents alone are not enough, because a crash can
 * lose a newly created name that the parent directory never synced. Shared with the
 * store's snapshot writer for the same reason the spool needs it.
 */
export function syncDirectory(path: string): void { const fd = openSync(dirname(path), "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
function durableWrite(path: string, text: string): void {
  const fd = openSync(path, "w", 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
}
function linesAt(path: string): string[] {
  try { return readFileSync(path, "utf8").split("\n").filter(Boolean); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw new Error("spool_unreadable: evidence could not be read"); }
}
const flights = new Map<string, Promise<number>>();
/** Health codes a spool marker may carry; anything else is surfaced as `evidence_needs_review`. */
export const SPOOL_CODES = ["evidence_spool_full", "evidence_write_failed", "evidence_delivery_failed", "evidence_invalid", "evidence_refused", "spool_invalid", "spool_unreadable", "spool_needs_review"] as const;
/**
 * Record coarse health metadata next to a spool -- never the refused record, a parser
 * exception, or any content. A marker is the only durable signal that evidence needs review.
 */
function writeProblemMarker(markerPath: string, code: string): void {
  try {
    durableWrite(markerPath + ".tmp", JSON.stringify({ code, at: Date.now() }));
    renameSync(markerPath + ".tmp", markerPath);
    syncDirectory(markerPath);
  } catch { /* stderr is the fallback when storage itself failed */ }
}

/** A rotated snapshot is separate from the active append file. Ack loss only causes replay. */
export class EvidenceSpool {
  readonly path: string;
  private warned = false;
  private readonly retry: ReturnType<typeof setInterval>;
  constructor(private readonly options: SpoolOptions) {
    this.path = options.spoolPath;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    for (const path of [this.path, this.path + ".pending"]) {
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error("spool_invalid: evidence must be a regular file");
    }
    if (!existsSync(this.path)) writeFileSync(this.path, "", { mode: 0o600, flag: "wx" });
    chmodSync(this.path, 0o600);
    this.retry = setInterval(() => { try { if (this.pendingBytes > 0) void this.flush().catch(() => undefined); } catch { this.problem("evidence_write_failed"); } }, options.retryIntervalMs ?? 15_000);
    this.retry.unref?.();
  }
  get pendingBytes(): number { return size(this.path) + size(this.path + ".pending"); }
  private problem(code: string, loss = false): void {
    writeProblemMarker(this.path + (loss ? ".loss" : ".error"), code);
    if (!this.warned) {
      this.warned = true;
      const message = `Workspan: ${code === "evidence_spool_full" ? "evidence spool is full" : code} at ${this.path}; evidence needs review`;
      if (this.options.onFull) this.options.onFull(message); else console.error(message);
    }
  }
  append(event: unknown): boolean {
    let line: string;
    try { line = JSON.stringify({ v: EVIDENCE_VERSION, ...validateEvent(event) }) + "\n"; }
    catch { this.problem("evidence_invalid", true); return false; }
    try {
      if (this.pendingBytes + Buffer.byteLength(line) > (this.options.maxBytes ?? MAX_SPOOL_BYTES)) { this.problem("evidence_spool_full", true); return false; }
      const fd = openSync(this.path, "a", 0o600);
      try { writeFileSync(fd, line); fsyncSync(fd); } finally { closeSync(fd); }
      syncDirectory(this.path);
      return true;
    } catch { this.problem("evidence_write_failed", true); return false; }
  }
  flush(): Promise<number> {
    const active = flights.get(this.path);
    if (active) {
      // An explicit flush also waits for appends already queued when it was called.
      // Appends made later remain in the active file for their own flush/retry.
      if (size(this.path) === 0) return active;
      return active.then(delivered => this.flush().then(more => delivered + more), () => this.flush());
    }
    const flight = this.drain().catch((error: unknown) => {
      // A permanent refusal (`evidence_refused`, `spool_invalid`, `evidence_too_large`)
      // is not a transport failure: report the code drain chose so the two stay distinct.
      const code = /^([a-z_]+):/.exec(error instanceof Error ? error.message : "")?.[1];
      this.problem(code && (SPOOL_CODES as readonly string[]).includes(code) ? code : "evidence_delivery_failed");
      throw error;
    }).finally(() => { flights.delete(this.path); });
    flights.set(this.path, flight);
    return flight;
  }
  private async drain(): Promise<number> {
    const pending = this.path + ".pending";
    // Capture everything queued at entry, never appends made while awaiting a reply.
    if (!existsSync(pending)) {
      if (size(this.path) === 0) return 0;
      renameSync(this.path, pending);
      writeFileSync(this.path, "", { mode: 0o600, flag: "wx" });
      syncDirectory(this.path);
    } else if (size(this.path) > 0) {
      // Persist the combined snapshot BEFORE truncating active. A crash can replay
      // active twice, never erase it; identity dedupe keeps accounting unchanged.
      durableWrite(pending + ".tmp", [...linesAt(pending), ...linesAt(this.path)].join("\n") + "\n");
      renameSync(pending + ".tmp", pending); syncDirectory(pending);
      durableWrite(this.path, "");
    }
    const lines = linesAt(pending), candidates: Array<{ index: number; event: EvidenceEvent }> = [];
    for (const [index, line] of lines.entries()) {
      // validateEvent bounds every field, so a validated record always fits one batch;
      // a line that cannot be validated is retained instead of blocking the rest.
      try { candidates.push({ index, event: validateEvent(JSON.parse(line)) }); } catch { /* retain malformed records, but do not block valid evidence */ }
    }
    const acknowledged = new Set<number>();
    let start = 0;
    for (const batch of batchEvidence(candidates.map(row => row.event))) {
      const result = await request("ingest", { events: batch }, { socketPath: this.options.socketPath }) as { accepted?: number; duplicates?: number; conflicts?: number; receipts?: Array<{ status: string; eventId: string }> };
      const receipts = result.receipts;
      if (receipts) {
        if (receipts.length !== batch.length || receipts.some((receipt, i) => !["accepted", "duplicate", "conflict"].includes(receipt.status) || receipt.eventId !== eventId(candidates[start + i].event))) throw new Error("evidence_refused: invalid acknowledgement; evidence retained");
        // Every receipt is an acknowledgement, including a conflict: the daemon
        // stored that record in its review table, so resending it could never change
        // the outcome. Retiring it keeps the review visible in status and reports
        // instead of pinning every later observation behind it forever.
        for (let i = 0; i < batch.length; i++) acknowledged.add(candidates[start + i].index);
      } else {
        // Compatibility with an older all-or-nothing acknowledgement, which counted
        // conflicts as unacknowledged; they are recorded for review either way.
        if ((result.accepted ?? 0) + (result.duplicates ?? 0) + (result.conflicts ?? 0) !== batch.length) throw new Error("evidence_refused: unacknowledged evidence retained for review");
        for (let i = 0; i < batch.length; i++) acknowledged.add(candidates[start + i].index);
      }
      start += batch.length;
      const remaining = lines.filter((_, index) => !acknowledged.has(index));
      durableWrite(pending + ".tmp", remaining.join("\n") + (remaining.length ? "\n" : ""));
      renameSync(pending + ".tmp", pending); syncDirectory(pending);
    }
    if (acknowledged.size < lines.length) throw new Error(`${candidates.length < lines.length ? "spool_invalid" : "evidence_refused"}: unacknowledged evidence retained for review`);
    rmSync(pending, { force: true }); syncDirectory(pending);
    rmSync(this.path + ".error", { force: true });
    this.warned = false;
    return acknowledged.size;
  }
  lines(): string[] { return [...linesAt(this.path + ".pending"), ...linesAt(this.path)]; }
  dispose(): void {
    clearInterval(this.retry);
    if (!flights.has(this.path) && this.pendingBytes === 0) rmSync(this.path, { force: true });
  }
}

export interface SpoolFile { name: string; path: string; bytes: number; pid: number; alive: boolean }
const SPOOL_NAME = /^([a-z0-9]+)-spool-(\d+)(?:-recovery-(?:owner-(\d+)-)?[a-f0-9-]+)?\.jsonl(?:\.pending)?$/;
function family(name: string): string { const match = SPOOL_NAME.exec(name)!; return `${match[1]}-spool-${match[2]}`; }
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
/** One spool file, or nothing when the entry is not one this lane can own. */
function spoolFileOf(directory: string, name: string): SpoolFile | null {
  const match = SPOOL_NAME.exec(name);
  if (!match) return null;
  const pid = Number(match[3] ?? match[2]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const path = join(directory, name);
  try {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink()) return null;
    return { name, path, bytes: stat.size, pid, alive: pid === process.pid || processAlive(pid) };
  } catch { return null; }
}
function problemOf(directory: string, name: string): { name: string; code: string; at: number } {
  try {
    const value = JSON.parse(readFileSync(join(directory, name), "utf8"));
    return { name, code: (SPOOL_CODES as readonly string[]).includes(value.code) ? value.code as string : "evidence_needs_review", at: Number(value.at) || 0 };
  } catch { return { name, code: "evidence_needs_review", at: 0 }; }
}
export interface SpoolHealth { files: SpoolFile[]; problems: Array<{ name: string; code: string; at: number }> }
/**
 * One listing for both the pending numbers and the refusal markers, so a status
 * refresh never traverses the directory twice. An unreadable directory reports
 * nothing: a missing or forbidden spool is health data, never a daemon failure.
 */
export function spoolHealth(directory = spoolDirectory()): SpoolHealth {
  let names: string[];
  try { names = readdirSync(directory); } catch { return { files: [], problems: [] }; }
  const files: SpoolFile[] = [], problems: SpoolHealth["problems"] = [];
  for (const name of names) {
    if (/\.jsonl\.(loss|error)$/.test(name)) { problems.push(problemOf(directory, name)); continue; }
    const file = spoolFileOf(directory, name);
    if (file) files.push(file);
  }
  return { files: files.sort((a, b) => a.name.localeCompare(b.name)), problems };
}
export function listSpools(options: { directory?: string; prefix?: string } = {}): SpoolFile[] {
  return spoolHealth(options.directory ?? spoolDirectory()).files.filter(file => !options.prefix || file.name.startsWith(options.prefix));
}
export function spoolProblems(directory = spoolDirectory()): Array<{ name: string; code: string; at: number }> {
  return spoolHealth(directory).problems;
}

/** Claim one writer family, pending first. Owner identity remains visible across crashes. */
export async function drainOrphanedSpools(options: { socketPath?: string; directory?: string; prefix?: string } = {}): Promise<number> {
  let delivered = 0;
  const families = [...new Set(listSpools(options).map(file => family(file.name)))];
  for (const key of families) {
    // Recheck the family: a renamed anchor marks ALL siblings as owned. Two
    // drainers seeing the old snapshot compete for the same deterministic anchor.
    const files = listSpools(options).filter(file => family(file.name) === key).sort((a, b) => Number(b.name.endsWith(".pending")) - Number(a.name.endsWith(".pending")) || a.name.localeCompare(b.name));
    if (!files.length || files.some(file => file.alive)) continue;
    if (files.length > 2) {
      // Only a drainer removes spool files, so a family with more snapshots than one
      // writer can own cannot self-resolve: surface it rather than strand it silently.
      writeProblemMarker(files[0].path.replace(/\.pending$/, "") + ".error", "spool_needs_review");
      continue;
    }
    const anchor = files[0];
    const claimed = join(dirname(anchor.path), `${key}-recovery-owner-${process.pid}-${randomUUID()}.jsonl`);
    const moved: Array<{ original: string; claimed: string }> = [];
    let spool: EvidenceSpool | undefined;
    try {
      for (const file of files) {
        const target = claimed + (file.name.endsWith(".pending") ? ".pending" : "");
        // A legacy family with multiple active snapshots is ambiguous; retain it.
        if (moved.some(row => row.claimed === target)) throw new Error("spool_needs_review");
        renameSync(file.path, target); moved.push({ original: file.path, claimed: target }); syncDirectory(target);
      }
      spool = new EvidenceSpool({ spoolPath: claimed, socketPath: options.socketPath });
      delivered += await spool.flush();
      for (const file of files) rmSync(file.path.replace(/\.pending$/, "") + ".error", { force: true });
    } catch (error) {
      const base = anchor.path.replace(/\.pending$/, "");
      // An ambiguous family is retained for review, and that state must be visible:
      // no flush ran, so no marker exists yet.
      if (error instanceof Error && error.message.startsWith("spool_needs_review")) writeProblemMarker(base + ".error", "spool_needs_review");
      if (existsSync(claimed + ".error")) renameSync(claimed + ".error", base + ".error");
      // Return the combined/refused snapshot to the dead writer for later retry.
      // If capture failed halfway, preserve each original sibling instead.
      if (spool) {
        for (const suffix of [".pending", ""]) if (size(claimed + suffix) > 0 && !existsSync(base + suffix)) { renameSync(claimed + suffix, base + suffix); syncDirectory(base); }
      } else {
        for (const row of moved) if (!existsSync(row.original)) { renameSync(row.claimed, row.original); syncDirectory(row.original); }
      }
    } finally { spool?.dispose(); }
  }
  return delivered;
}
