#!/usr/bin/env bun
/** Daemon entry point. Usage: workspan daemon [--db path] [--runtime-dir path] [--idle-gap-ms n] */
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

const store = new WorkspanStore(database);
const daemon = await startDaemon({ store, runtimeDir, idleGapMs, statusIntervalMs });
console.log(JSON.stringify({ listening: daemon.socketPath, status: daemon.statusPath, database }));

const shutdown = async () => { await daemon.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
