/**
 * The daemon client library: the one place that knows how to frame a request and how
 * to hold evidence until the daemon accepts it. The CLI, `workspan mcp` and the
 * harness adapters all speak through here, so a protocol change lands once and no
 * adapter can drift from the contract in docs/protocol.md.
 */
import { connect } from "node:net";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { encodeFrame, parseResponse, PROTOCOL_VERSION, type Method } from "./protocol.ts";
import { socketPath as socketPathFor } from "./daemon/paths.ts";

export const DEFAULT_TIMEOUT_MS = 5_000;
/** A spool this big means the daemon has been down for a long time; say so, once. */
export const MAX_SPOOL_BYTES = 10 * 1024 * 1024;

export interface RequestOptions { socketPath?: string; timeoutMs?: number; id?: string }

export function defaultSocketPath(): string { return socketPathFor(); }

/**
 * One request over the local socket. A daemon-side failure rejects with an Error
 * whose message is `code: message`, so callers can show exactly what was refused.
 */
export function request(method: Method, params?: unknown, options: RequestOptions = {}): Promise<unknown> {
  const socketFile = options.socketPath ?? defaultSocketPath();
  return new Promise((resolve, reject) => {
    const client = connect(socketFile);
    let buffer = "";
    const fail = (message: string) => { client.destroy(); reject(new Error(message)); };
    client.setTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    client.on("connect", () => client.write(encodeFrame({
      v: PROTOCOL_VERSION,
      id: options.id ?? `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      method,
      params,
    })));
    client.on("data", chunk => {
      buffer += chunk.toString("utf8");
      const index = buffer.indexOf("\n");
      if (index === -1) return;
      try {
        const response = parseResponse(buffer.slice(0, index));
        client.destroy();
        if (response.ok) resolve(response.result);
        else reject(new Error(`${response.error.code}: ${response.error.message}`));
      } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    });
    client.on("timeout", () => fail(`daemon not responding at ${socketFile}`));
    client.on("error", error => fail(`cannot reach the Workspan daemon at ${socketFile} (${(error as NodeJS.ErrnoException).code ?? "error"}); start it with: workspan daemon`));
  });
}

/** The typed convenience layer: what a harness adapter or a tool surface should use. */
export class WorkspanClient {
  readonly socketPath: string;
  constructor(options: RequestOptions = {}) { this.socketPath = options.socketPath ?? defaultSocketPath(); }
  request(method: Method, params?: unknown): Promise<unknown> { return request(method, params, { socketPath: this.socketPath }); }
  health(): Promise<unknown> { return this.request("health"); }
  status(): Promise<unknown> { return this.request("status"); }
  day(options: { date?: string; timezone?: string } = {}): Promise<unknown> { return this.request("day", options); }
  sessions(): Promise<unknown> { return this.request("session.list"); }
  projects(): Promise<unknown> { return this.request("projects"); }
  ingest(events: readonly unknown[]): Promise<unknown> { return this.request("ingest", { events }); }
  session(action: "start" | "stop" | "pause" | "resume" | "toggle" | "switch", params: Record<string, unknown> = {}): Promise<unknown> {
    return this.request(`session.${action}` as Method, params);
  }
  note(params: { note: string; session?: string; idle?: boolean }): Promise<unknown> { return this.request("session.note", params); }
  bind(root: string, project: string, explicit = true): Promise<unknown> { return this.request("projects.bind", { root, project, explicit }); }
}

/** Where adapters keep undelivered evidence: private, per user, outside any repository. */
export function spoolDirectory(): string {
  return process.env.WORKSPAN_SPOOL_DIR
    ?? join(process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? "/tmp", ".local", "state"), "workspan");
}

export interface SpoolOptions { spoolPath: string; socketPath?: string; maxBytes?: number; onFull?: (message: string) => void }

/**
 * At-least-once delivery for evidence producers. The line is on disk before the
 * socket is tried and the spool is cleared only after the daemon accepted the batch,
 * so a stopped daemon loses nothing and a replay is a duplicate, never a conflict.
 */
export class EvidenceSpool {
  readonly path: string;
  private full = false;
  constructor(private readonly options: SpoolOptions) {
    this.path = options.spoolPath;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    if (!existsSync(this.path)) writeFileSync(this.path, "", { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }
  get pendingBytes(): number { try { return statSync(this.path).size; } catch { return 0; } }
  /** Append one event. A full spool refuses loudly once instead of dropping silently. */
  append(event: unknown): boolean {
    try {
      if (this.pendingBytes > (this.options.maxBytes ?? MAX_SPOOL_BYTES)) {
        if (!this.full) { this.full = true; this.options.onFull?.(`Workspan: evidence spool is full at ${this.path}; start the daemon to drain it`); }
        return false;
      }
      appendFileSync(this.path, JSON.stringify(event) + "\n");
      return true;
    } catch { return false; }
  }
  /** Deliver everything held; returns how many events the daemon accepted. */
  async flush(): Promise<number> {
    const lines = this.lines();
    if (!lines.length) return 0;
    await request("ingest", { events: lines.map(line => JSON.parse(line) as unknown) }, { socketPath: this.options.socketPath });
    const tmp = this.path + ".draining";
    writeFileSync(tmp, "", { mode: 0o600 });
    renameSync(tmp, this.path);
    this.full = false;
    return lines.length;
  }
  lines(): string[] { try { return readFileSync(this.path, "utf8").split("\n").filter(Boolean); } catch { return []; } }
  /**
   * Remove the file when nothing is pending. An empty spool is litter, not evidence:
   * every adapter process that had nothing to send used to leave one behind forever.
   * A file that still holds undelivered evidence is never touched.
   */
  dispose(): void { if (this.pendingBytes === 0) rmSync(this.path, { force: true }); }
}

/** One spool file on disk, with the process that owns it. */
export interface SpoolFile { name: string; path: string; bytes: number; pid: number; alive: boolean }

/** `<adapter>-spool-<pid>.jsonl`: the naming every adapter shares. */
const SPOOL_NAME = /^[a-z0-9]+-spool-(\d+)\.jsonl$/;

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/**
 * Every spool file a producer may have left, for the drain and for the health report.
 * With no prefix the shared naming is matched, so a new adapter is covered without
 * registering anywhere; a prefix keeps the older exact-match call sites working.
 */
export function listSpools(options: { directory?: string; prefix?: string } = {}): SpoolFile[] {
  const directory = options.directory ?? spoolDirectory();
  let names: string[];
  try { names = readdirSync(directory); } catch { return []; }
  const found: SpoolFile[] = [];
  for (const name of names) {
    const digits = options.prefix
      ? (name.startsWith(options.prefix) && name.endsWith(".jsonl") ? name.slice(options.prefix.length).replace(/\.jsonl$/, "") : null)
      : SPOOL_NAME.exec(name)?.[1] ?? null;
    const pid = Number(digits);
    if (digits === null || !Number.isSafeInteger(pid)) continue;
    const path = join(directory, name);
    let bytes = 0;
    try { bytes = statSync(path).size; } catch { continue; }
    found.push({ name, path, bytes, pid, alive: pid === process.pid || processAlive(pid) });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Drain spools left by processes that are gone: a crashed adapter's evidence still
 * counts, and the daemon's identity dedupe makes delivery safe to retry. An empty
 * orphan is removed instead of opened.
 */
export async function drainOrphanedSpools(options: { socketPath?: string; directory?: string; prefix?: string } = {}): Promise<number> {
  let delivered = 0;
  for (const file of listSpools(options)) {
    if (file.pid === process.pid || file.alive) continue;
    if (file.bytes === 0) { rmSync(file.path, { force: true }); continue; }
    const spool = new EvidenceSpool({ spoolPath: file.path, socketPath: options.socketPath });
    try {
      delivered += await spool.flush();
      if (spool.pendingBytes === 0) rmSync(file.path, { force: true });
    } catch { /* undeliverable now: leave it for the next session to try */ }
  }
  return delivered;
}
