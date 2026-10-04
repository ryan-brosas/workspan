import { randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION, type WorkspanStore } from "./db.ts";

export const DEFAULT_BACKUP_KEEP = 7;
export const MAX_BACKUP_KEEP = 365;
export interface BackupResult {
  path: string;
  revision: number;
  /** Unique stored observation identities, not hours or a sum of measures. */
  identities: number;
  /** The evidence schema the snapshot was written with. */
  schema_version: number;
  removed: number;
}

const MANAGED_NAME = /^workspan-backup-[0-9]{16}-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}[.]sqlite$/;

/** Read without opening a WorkspanStore: validation must never migrate a backup. */
function validateSnapshot(path: string): Pick<BackupResult, "revision" | "identities" | "schema_version"> {
  const file = lstatSync(path);
  if (!file.isFile() || file.nlink !== 1 || (file.mode & 0o777) !== 0o600 || (process.getuid && file.uid !== process.getuid())) {
    throw new Error("Backup must be a private, owned regular file without links");
  }
  // A managed backup is standalone, not another live ledger or a WAL bundle.
  if (["-wal", "-shm", "-journal"].some(suffix => lstatSync(`${path}${suffix}`, { throwIfNoEntry: false }))) {
    throw new Error("Backup must not have SQLite sidecars");
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const check = db.prepare("pragma integrity_check").all();
    if (check.length !== 1 || check[0].integrity_check !== "ok") throw new Error("Backup integrity check failed");
    const schema = db.prepare("select value from meta where key = 'schema_version'").get();
    if (schema?.value !== String(SCHEMA_VERSION)) throw new Error("Backup schema version is unsupported");
    const value = db.prepare("select value from meta where key = 'revision'").get()?.value ?? "0";
    const revision = Number(value);
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(revision)) {
      throw new Error("Backup revision is invalid");
    }
    const identities = db.prepare("select count(*) as identities from observations").get()?.identities;
    if (typeof identities !== "number" || !Number.isSafeInteger(identities) || identities < 0) throw new Error("Backup identity count is invalid");
    return { revision, identities, schema_version: SCHEMA_VERSION };
  } finally { db.close(); }
}

/** Called only by the daemon, using its already-open writer. Never opens the source again. */
export function createBackup(store: WorkspanStore, options: { keep?: number; now?: number } = {}): BackupResult {
  const { keep = DEFAULT_BACKUP_KEEP, now = Date.now() } = options;
  if (!Number.isInteger(keep) || keep < 1 || keep > MAX_BACKUP_KEEP) throw new Error(`keep must be an integer from 1 to ${MAX_BACKUP_KEEP}`);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("now must be a nonnegative safe integer timestamp");

  const directory = join(dirname(resolve(store.path)), "backups");
  // One look at the entry, then a real directory check: a regular file or a symlink
  // here would otherwise surface as a raw ENOTDIR or ELOOP from the open below.
  const existing = lstatSync(directory, { throwIfNoEntry: false });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error(`backup directory ${directory} must be a real directory`);
  if (!existing) { try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let pending = false;
  const path = join(directory, `workspan-backup-${String(now).padStart(16, "0")}-${randomUUID()}.sqlite`);
  const temporary = `${path}.partial`;
  try {
    if (process.getuid && fstatSync(fd).uid !== process.getuid()) throw new Error("Backup directory must belong to this user");
    fchmodSync(fd, 0o700);
    // The partial is reserved before the snapshot, so a failure inside snapshotTo
    // still leaves the finally responsible for it.
    pending = true;
    store.snapshotTo(temporary);
    const metadata = validateSnapshot(temporary);
    // link, unlike rename, atomically refuses any existing final destination.
    linkSync(temporary, path);
    // The durable snapshot exists from here on: a failed cleanup is a leftover, not a
    // failed backup, and the sweep below reclaims it.
    try { unlinkSync(temporary); } catch { /* the snapshot is linked; nothing is lost */ }
    pending = false;
    fsyncSync(fd);

    // Count only validated, strictly named snapshots. Unknown/corrupt files, links and
    // crash leftovers written by anything but this daemon are left alone: the sweep
    // may only remove a file it can prove it owns. The just-created backup survives
    // clock rollback, and a leftover partial is reclaimed by an operator, not guessed at.
    const previous = readdirSync(directory).filter(name => MANAGED_NAME.test(name))
      .map(name => join(directory, name)).filter(candidate => candidate !== path)
      .filter(candidate => {
        try { validateSnapshot(candidate); return true; }
        catch { return false; }
      }).sort().reverse();
    let removed = 0;
    for (const candidate of previous.slice(keep - 1)) {
      unlinkSync(candidate);
      removed++;
    }
    if (removed) fsyncSync(fd);
    return { path, ...metadata, removed };
  } finally {
    try { if (pending) unlinkSync(temporary); }
    finally { closeSync(fd); }
  }
}
