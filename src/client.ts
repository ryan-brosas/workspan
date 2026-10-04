/** Shared IPC and durable evidence delivery. Clients never open the accounting database. */
import { connect } from "node:net";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { encodeFrame, MAX_FRAME_BYTES, parseResponse, PROTOCOL_VERSION, type Method, type ReportQuery, type ReportPage } from "./protocol.ts";
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
      buffer += chunk.toString("utf8");
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

/** Input AND acknowledgement remain below the frame limit, including UTF-8 identities. */
export function batchEvidence(events: readonly unknown[]): unknown[][] {
  const batches: unknown[][] = [];
  let current: unknown[] = [], bytes = 0;
  for (const event of events) {
    const size = Buffer.byteLength(JSON.stringify(event)) + 1;
    if (size > 24_000) throw new Error("event_too_large: evidence exceeds the batch limit");
    if (current.length >= 100 || bytes + size > 24_000) { batches.push(current); current = []; bytes = 0; }
    current.push(event); bytes += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

/** Fetch chunks of one immutable snapshot; a changing ledger cannot mix pages. */
export async function readReport(query: ReportQuery, send: (method: Method, params?: unknown) => Promise<unknown>): Promise<string> {
  let params: unknown = query, token: string | null = null, offset = 0, text = "";
  for (;;) {
    const page = await send("report", params) as ReportPage;
    if (typeof page.chunk !== "string" || typeof page.token !== "string" || page.offset !== offset || (token !== null && page.token !== token)) throw new Error("bad_response: invalid report page");
    token = page.token;
    text += page.chunk;
    if (text.length > 16 * 1024 * 1024) throw new Error("report_too_large: report exceeds the snapshot limit");
    if (page.next === null) return text;
    if (!Number.isSafeInteger(page.next) || page.next !== offset + page.chunk.length || page.next <= offset) throw new Error("bad_response: invalid report cursor");
    offset = page.next;
    params = { token, offset };
  }
}

export class WorkspanClient {
  readonly socketPath: string;
  constructor(options: RequestOptions = {}) { this.socketPath = options.socketPath ?? defaultSocketPath(); }
  request(method: Method, params?: unknown): Promise<unknown> { return request(method, params, { socketPath: this.socketPath }); }
  health(): Promise<unknown> { return this.request("health"); }
  status(): Promise<unknown> { return this.request("status"); }
  day(options: { date?: string; timezone?: string } = {}): Promise<unknown> { return this.request("day", options); }
  report(query: ReportQuery): Promise<string> { return readReport(query, (method, params) => this.request(method, params)); }
  sessions(): Promise<unknown> { return this.request("session.list"); }
  projects(): Promise<unknown> { return this.request("projects"); }
  ingest(events: readonly unknown[]): Promise<unknown> { return this.request("ingest", { events }); }
  session(action: "start" | "stop" | "pause" | "resume" | "toggle" | "switch", params: Record<string, unknown> = {}): Promise<unknown> { return this.request(`session.${action}` as Method, params); }
  note(params: { note: string; session?: string; idle?: boolean }): Promise<unknown> { return this.request("session.note", params); }
  bind(root: string, project: string, explicit = true): Promise<unknown> { return this.request("projects.bind", { root, project, explicit }); }
}

export function spoolDirectory(): string {
  return process.env.WORKSPAN_SPOOL_DIR ?? join(process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? "/tmp", ".local", "state"), "workspan");
}
export interface SpoolOptions { spoolPath: string; socketPath?: string; maxBytes?: number; onFull?: (message: string) => void; retryIntervalMs?: number }

function size(path: string): number { try { return lstatSync(path).size; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; } }
function syncDirectory(path: string): void { const fd = openSync(dirname(path), "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
function durableWrite(path: string, text: string): void {
  const fd = openSync(path, "w", 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
}
function linesAt(path: string): string[] {
  try { return readFileSync(path, "utf8").split("\n").filter(Boolean); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw new Error("spool_unreadable: evidence could not be read"); }
}
const flights = new Map<string, Promise<number>>();

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
    // Only coarse health metadata, never the refused record or parser exception.
    try { const path = this.path + (loss ? ".loss" : ".error"); durableWrite(path + ".tmp", JSON.stringify({ code, at: Date.now() })); renameSync(path + ".tmp", path); syncDirectory(path); } catch { /* stderr is the fallback when storage itself failed */ }
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
    const flight = this.drain().catch(error => { this.problem("evidence_delivery_failed"); throw error; }).finally(() => { flights.delete(this.path); });
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
export function listSpools(options: { directory?: string; prefix?: string } = {}): SpoolFile[] {
  const directory = options.directory ?? spoolDirectory();
  let names: string[];
  try { names = readdirSync(directory); } catch { return []; }
  const found: SpoolFile[] = [];
  for (const name of names) {
    const match = SPOOL_NAME.exec(name);
    if (!match || (options.prefix && !name.startsWith(options.prefix))) continue;
    const pid = Number(match[3] ?? match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const path = join(directory, name);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink()) continue;
    found.push({ name, path, bytes: stat.size, pid, alive: pid === process.pid || processAlive(pid) });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}
export function spoolProblems(directory = spoolDirectory()): Array<{ name: string; code: string; at: number }> {
  let names: string[]; try { names = readdirSync(directory); } catch { return []; }
  return names.filter(name => /\.jsonl\.(loss|error)$/.test(name)).map(name => {
    try {
      const value = JSON.parse(readFileSync(join(directory, name), "utf8"));
      return { name, code: ["evidence_spool_full", "evidence_write_failed", "evidence_delivery_failed", "evidence_invalid"].includes(value.code) ? value.code as string : "evidence_needs_review", at: Number(value.at) || 0 };
    } catch { return { name, code: "evidence_needs_review", at: 0 }; }
  });
}

/** Claim one writer family, pending first. Owner identity remains visible across crashes. */
export async function drainOrphanedSpools(options: { socketPath?: string; directory?: string; prefix?: string } = {}): Promise<number> {
  let delivered = 0;
  const families = [...new Set(listSpools(options).map(file => family(file.name)))];
  for (const key of families) {
    // Recheck the family: a renamed anchor marks ALL siblings as owned. Two
    // drainers seeing the old snapshot compete for the same deterministic anchor.
    const files = listSpools(options).filter(file => family(file.name) === key).sort((a, b) => Number(b.name.endsWith(".pending")) - Number(a.name.endsWith(".pending")) || a.name.localeCompare(b.name));
    if (!files.length || files.some(file => file.alive) || files.length > 2) continue;
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
    } catch {
      const base = anchor.path.replace(/\.pending$/, "");
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
