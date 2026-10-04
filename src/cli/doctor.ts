/**
 * Is the whole thing wired? One read-only check of the daemon, the status file, the
 * collector service and its spool, the database file and how fresh each evidence
 * source is. It never repairs anything, and it never opens the database: the daemon
 * is the only process that does that.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { WorkspanClient } from "../client.ts";
import { listSpools, spoolDirectory, spoolProblems } from "../spool.ts";
import { defaultDatabasePath, defaultRuntimeDir, socketPath, statusPath } from "../daemon/paths.ts";
import type { Status } from "../daemon/measures.ts";

export interface Check { name: string; state: "ok" | "attention" | "unknown"; detail: string }
export interface DoctorReport { verdict: "ok" | "attention"; checks: Check[] }
export interface DoctorOptions { socketPath?: string; runtimeDir?: string; databasePath?: string; spoolDir?: string; now?: number }

/** Three missed passes of the ingest loop's 15s timer mean the lane stopped writing. */
const HEARTBEAT_STALE_MS = 45_000;

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

  // The ingest loop's heartbeat. The collector emits nothing while nothing changes,
  // so a quiet seat and a broken pipeline look identical in the evidence: this is
  // the only signal that tells them apart, and it is what a stale lane was hiding.
  const healthFile = join(runtimeDir, "collector.health");
  try {
    const beat = Number(readFileSync(healthFile, "utf8").trim());
    const age = now - beat;
    checks.push(Number.isFinite(beat) && age < HEARTBEAT_STALE_MS
      ? { name: "collector heartbeat", state: "ok", detail: `written ${Math.round(age / 1000)}s ago` }
      : { name: "collector heartbeat", state: "attention", detail: `${healthFile} last written ${Number.isFinite(beat) ? `${Math.round(age / 1000)}s ago` : "unreadably"}; the ingest loop is not running` });
  } catch {
    checks.push({ name: "collector heartbeat", state: "unknown", detail: "no heartbeat yet: the ingest loop has not run in this session" });
  }

  // Adapter spools are evidence in transit: an empty file is litter a producer left
  // behind, a non-empty one is something that has not reached the daemon.
  // One directory for both delivery checks, so they can never inspect two different places.
  const spoolDir = options.spoolDir ?? spoolDirectory();
  const spools = listSpools({ directory: spoolDir });
  const pending = spools.filter(file => file.bytes > 0);
  if (!pending.length) {
    checks.push({ name: "adapter spools", state: "ok", detail: spools.length === 0 ? "none" : `${spools.length} empty file(s) left by producers` });
  } else {
    const bytes = pending.reduce((sum, file) => sum + file.bytes, 0);
    const oldest = Math.min(...pending.map(file => { try { return statSync(file.path).mtimeMs; } catch { return now; } }));
    checks.push({ name: "adapter spools", state: "attention", detail: `${pending.length} file(s), ${bytes} bytes pending, oldest ${Math.round((now - oldest) / 1000)}s: evidence has not reached the daemon` });
  }

  // Automatic harness detection: a pass older than three intervals means the scan
  // stopped, and a store that was found is stated instead of silently absent.
  const harness = status?.harness;
  if (harness) {
    const readers = `${harness.readers.length} reader(s), ${harness.readers.filter(reader => reader.available).length} store(s) detected`;
    const failed = harness.readers.filter(reader => reader.error);
    const age = harness.polled_at === null ? null : now - harness.polled_at;
    const staleMs = Math.max(harness.interval_ms * 3, 60_000);
    if (harness.interval_ms === 0) checks.push({ name: "harness detection", state: "ok", detail: "automatic detection is off (--no-harness); run workspan ingest-harness" });
    else if (harness.error) checks.push({ name: "harness detection", state: "attention", detail: `${harness.error}; ${readers}` });
    else if (failed.length) checks.push({ name: "harness detection", state: "attention", detail: `${failed.map(reader => `${reader.id}: ${reader.error}`).join("; ")}; ${readers}` });
    else if (age === null) checks.push({ name: "harness detection", state: "unknown", detail: `no pass yet; ${readers}` });
    else if (age > staleMs) checks.push({ name: "harness detection", state: "attention", detail: `last pass ${Math.round(age / 1000)}s ago, interval ${Math.round(harness.interval_ms / 1000)}s: the scan stopped; ${readers}` });
    else {
      const accepted = harness.readers.reduce((sum, reader) => sum + reader.accepted, 0);
      checks.push({ name: "harness detection", state: "ok", detail: `${readers}, ${accepted} accepted in the last pass ${Math.round(age / 1000)}s ago` });
    }
  }

  // Conflicts are review debt, not work: the record was retained, but an identity
  // was replayed with different metadata. Reports warn about it too.
  const conflicts = status?.coverage?.conflicts ?? 0;
  if (conflicts) checks.push({ name: "evidence conflicts", state: "attention", detail: `${conflicts} record(s) retained for review; day/week reports warn with conflicting_evidence` });

  const problems = spoolProblems(spoolDir);
  if (problems.length) checks.push({ name: "evidence delivery", state: "attention", detail: `${problems.length} delivery/refusal marker(s): ${[...new Set(problems.map(problem => problem.code))].join(", ")}; inspect metadata in the spool directory` });

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
