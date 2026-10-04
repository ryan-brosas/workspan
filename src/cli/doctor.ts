/**
 * Is the whole thing wired? One read-only check of the daemon, the status file, the
 * collector service and its spool, the database file and how fresh each evidence
 * source is. It never repairs anything, and it never opens the database: the daemon
 * is the only process that does that.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { WorkspanClient } from "../client.ts";
import { defaultDatabasePath, defaultRuntimeDir, socketPath, statusPath } from "../daemon/paths.ts";
import type { Status } from "../daemon/measures.ts";

export interface Check { name: string; state: "ok" | "attention" | "unknown"; detail: string }
export interface DoctorReport { verdict: "ok" | "attention"; checks: Check[] }
export interface DoctorOptions { socketPath?: string; runtimeDir?: string; databasePath?: string; now?: number }

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const runtimeDir = options.runtimeDir ?? defaultRuntimeDir();
  const socketFile = options.socketPath ?? socketPath(runtimeDir);
  const statusFile = statusPath(runtimeDir);
  const database = options.databasePath ?? defaultDatabasePath();
  const now = options.now ?? Date.now();
  const client = new WorkspanClient({ socketPath: socketFile });
  const checks: Check[] = [];

  const socket = socketCheck(socketFile);
  checks.push(socket);

  let status: Status | null = null;
  try {
    const health = (await client.health()) as { state?: string; protocol?: number; schema?: number; database?: string };
    checks.push({ name: "daemon", state: "ok", detail: `state ${health.state ?? "ok"}, protocol ${health.protocol}, schema ${health.schema}, ${health.database ?? database}` });
    status = (await client.status()) as Status;
  } catch (error) {
    checks.push({ name: "daemon", state: "attention", detail: message(error) });
  }

  try {
    const age = now - statSync(statusFile).mtimeMs;
    checks.push({ name: "status file", state: age < 60_000 ? "ok" : "attention", detail: `${statusFile} written ${Math.round(age / 1000)}s ago` });
  } catch {
    checks.push({ name: "status file", state: "attention", detail: `nothing at ${statusFile}` });
  }

  const collector = systemdUserUnit("workspan-collector.service", "presence collection");
  checks.push(collector);

  const spoolFile = join(runtimeDir, "collector.pending");
  try {
    const size = statSync(spoolFile).size;
    checks.push({ name: "collector spool", state: size === 0 ? "ok" : "attention", detail: size === 0 ? "empty" : `${size} bytes pending; the daemon may be unreachable` });
  } catch {
    // No spool file just means nothing has been written yet; that is healthy while
    // the collector runs, and unverifiable when it does not.
    checks.push(collector.state === "ok"
      ? { name: "collector spool", state: "ok", detail: "no spool file yet: nothing pending" }
      : { name: "collector spool", state: "unknown", detail: "no spool file: the collector has not run in this session" });
  }

  const sources = status?.coverage?.sources ?? [];
  if (sources.length) {
    for (const source of sources) {
      const age = now - source.cursor;
      checks.push({ name: `evidence ${source.source}`, state: "ok", detail: `${source.events} event(s), last ${Math.round(age / 1000)}s ago` });
    }
  } else if (status) {
    checks.push({ name: "evidence", state: "attention", detail: "no source has delivered evidence yet" });
  }

  try {
    const db = statSync(database);
    const wal = existsSync(database + "-wal") ? statSync(database + "-wal").size : 0;
    checks.push({ name: "database", state: "ok", detail: `${Math.round(db.size / 1024)} KiB with ${Math.round(wal / 1024)} KiB wal at ${database}` });
  } catch {
    checks.push({ name: "database", state: "unknown", detail: `no database file yet at ${database}` });
  }

  return { verdict: checks.some(check => check.state === "attention") ? "attention" : "ok", checks };
}

function socketCheck(socketFile: string): Check {
  try {
    const mode = statSync(socketFile).mode & 0o777;
    return { name: "socket", state: mode === 0o600 ? "ok" : "attention", detail: `${socketFile}, mode ${mode.toString(8)}` };
  } catch {
    return { name: "socket", state: "attention", detail: `nothing at ${socketFile}` };
  }
}

function systemdUserUnit(name: string, what: string): Check {
  const result = spawnSync("systemctl", ["--user", "is-active", name], { encoding: "utf8" });
  if (result.error) return { name: `unit ${name}`, state: "unknown", detail: `systemctl unavailable; ${what} cannot be confirmed here` };
  const state = (result.stdout ?? "").trim();
  if (state === "active") return { name: `unit ${name}`, state: "ok", detail: "active" };
  if (state === "inactive" || state === "failed") return { name: `unit ${name}`, state: "attention", detail: `${state}; systemctl --user status ${name}` };
  return { name: `unit ${name}`, state: "unknown", detail: `${state || "not installed"}; install it from packaging/` };
}
