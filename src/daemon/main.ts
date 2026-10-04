#!/usr/bin/env bun
/**
 * Daemon entry point.
 *
 * Usage: workspan daemon [--db path] [--runtime-dir path] [--spool-dir path]
 *        [--idle-gap-ms n] [--status-interval-ms n] [--harness-poll-ms n]
 *        [--harness-window-ms n] [--no-harness]
 *
 * Environment: WORKSPAN_SPOOL_DIR sets the spool directory when --spool-dir is absent.
 * Every millisecond flag needs a positive number; a malformed value exits 2 instead of
 * silently disabling the behavior it configures.
 */
import { defaultDatabasePath, defaultRuntimeDir } from "./paths.ts";
import { WorkspanStore } from "./db.ts";
import { startDaemon } from "./server.ts";

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}

function msFlag(args: string[], name: string, fallback: number): number {
  const raw = flag(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  // A NaN or zero interval is not a configured interval: it would disable detection or
  // spin it, so an invalid value is refused rather than coerced.
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`workspan daemon: ${name} needs a positive number of milliseconds; got ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  return value;
}

const args = process.argv.slice(2);
const database = flag(args, "--db") ?? defaultDatabasePath();
const runtimeDir = flag(args, "--runtime-dir") ?? defaultRuntimeDir();
const spoolDir = flag(args, "--spool-dir") ?? process.env.WORKSPAN_SPOOL_DIR;
const idleGapMs = msFlag(args, "--idle-gap-ms", 15 * 60_000);
const statusIntervalMs = msFlag(args, "--status-interval-ms", 15_000);
// Automatic harness detection is on by default; --no-harness is the explicit off.
const harnessPollMs = args.includes("--no-harness") ? 0 : msFlag(args, "--harness-poll-ms", 300_000);
const harnessWindowMs = msFlag(args, "--harness-window-ms", 7 * 86_400_000);

const store = new WorkspanStore(database);
const daemon = await startDaemon({
  store,
  runtimeDir,
  idleGapMs,
  statusIntervalMs,
  harnessPollMs,
  harnessWindowMs,
  ...(spoolDir ? { spoolDir } : {}),
});
console.log(JSON.stringify({ listening: daemon.socketPath, status: daemon.statusPath, database }));

const shutdown = async () => { await daemon.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
