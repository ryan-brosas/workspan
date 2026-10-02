import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Runtime files (socket, status) live in a private per-user directory. */
export function defaultRuntimeDir(): string {
  return process.env.WORKSPAN_RUNTIME_DIR ?? join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), "workspan");
}
export function socketPath(runtimeDir = defaultRuntimeDir()): string { return join(runtimeDir, "workspan.sock"); }
export function statusPath(runtimeDir = defaultRuntimeDir()): string { return join(runtimeDir, "status.json"); }

export function defaultDatabasePath(): string {
  return process.env.WORKSPAN_DB_PATH ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "workspan", "workspan.sqlite");
}
