#!/usr/bin/env bun
/** Daemon entry point. Usage: workspan daemon [--db path] [--runtime-dir path] [--idle-gap-ms n] [--no-harness] */
import { defaultDatabasePath, defaultRuntimeDir } from "./paths.ts";
import { WorkspanStore } from "./db.ts";
import { startDaemon } from "./server.ts";

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}

const args = process.argv.slice(2);
const database = flag(args, "--db") ?? defaultDatabasePath();
const runtimeDir = flag(args, "--runtime-dir") ?? defaultRuntimeDir();
const idleGapMs = Number(flag(args, "--idle-gap-ms") ?? 15 * 60_000);
const statusIntervalMs = Number(flag(args, "--status-interval-ms") ?? 15_000);
// Automatic harness detection is on by default; --no-harness is the explicit off.
const harnessPollMs = args.includes("--no-harness") ? 0 : Number(flag(args, "--harness-poll-ms") ?? 300_000);
const harnessWindowMs = Number(flag(args, "--harness-window-ms") ?? 7 * 86_400_000);

const store = new WorkspanStore(database);
const daemon = await startDaemon({ store, runtimeDir, idleGapMs, statusIntervalMs, harnessPollMs, harnessWindowMs, ...(process.env.WORKSPAN_SPOOL_DIR ? { spoolDir: process.env.WORKSPAN_SPOOL_DIR } : {}) });
console.log(JSON.stringify({ listening: daemon.socketPath, status: daemon.statusPath, database }));

const shutdown = async () => { await daemon.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
