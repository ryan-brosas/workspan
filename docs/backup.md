# Local backups

Backups are created by the daemon through its already-open `WorkspanStore`.
There is no second writer, live file copy, evidence expiry or spool cleanup.
These are local recovery snapshots, not protection against losing the disk.

## Integration API

`src/daemon/backup.ts` exports the synchronous API:

```ts
createBackup(store: WorkspanStore, options?: { keep?: number; now?: number }): BackupResult
// { path: string, revision: number, identities: number, schema_version: number, removed: number }
```

- Call it only from the daemon, with its existing store; clients request it over
  IPC using `workspan backup --keep 7` (or protocol method `backup`).
- `keep` defaults to `DEFAULT_BACKUP_KEEP` (7), and must be an integer from 1 to
  `MAX_BACKUP_KEEP` (365). Invalid options fail before filesystem changes.
- `now` is an optional nonnegative safe-integer Unix millisecond timestamp for
  filename ordering/testing. Retention is count-based, not age-based; evidence
  is unchanged.
- `path` is absolute. `revision`, `identities` (the unique observation count) and
  `schema_version` come from the snapshot, not the subsequently changing source.
  `removed` counts old validated snapshots actually deleted.
- Errors throw. No success should be reported by the caller on failure.

`WorkspanStore.snapshotTo(path): void` is the low-level snapshot primitive. It
requires a private parent directory and refuses every existing destination,
including empty files and dangling symlinks. It uses parameterized SQLite
`VACUUM INTO` on the writer connection and syncs the resulting file. As a
synchronous operation it blocks daemon request handling while the snapshot runs;
ingestion can continue afterward without reopening the store. Disk space for a full snapshot
is required.

## Files and retention

The destination is fixed: `dirname(database)/backups`. The managed directory is
owned by the daemon user and mode `0700`; snapshots are `0600`. An existing real,
owned directory is tightened to `0700`. A symlink directory is refused. This
protects against other users and accidental path hazards, not malicious code
already running as the daemon's user.

Names are `workspan-backup-<16-digit timestamp>-<uuid>.sqlite`, where the timestamp
is the millisecond value zero-padded to 16 digits (13 digits today), so names sort
lexicographically by time and stay padded well past the millisecond range. Creation first
writes a private `.partial` file, then validates it read-only with SQLite
`integrity_check`, the supported schema version, revision and identity count.
A no-overwrite hard-link publication and directory sync precede any pruning.
The final snapshot is standalone and needs no source WAL or SHM file.

Retention always keeps the just-created snapshot, even after clock rollback,
plus the newest `keep - 1` validated managed snapshots, ordered by filename
(timestamp, then UUID for ties). Only exact managed names that pass the same
validation are eligible. Symlinks, hard-linked files, SQLite sidecars, partial
files, unsupported schemas, corrupt snapshots and unrelated files are neither
counted nor deleted. They may therefore make the directory exceed `keep`; review
such leftovers explicitly rather than silently deleting them. Never place
another ledger or evidence spool under managed snapshot names.

Snapshot, validation or publication failure leaves older backups untouched.
If pruning fails after publication, the new valid backup remains and the call
throws; some excess older backups may remain. A crash may leave a `.partial`
file, which retention deliberately ignores. No source evidence or spools are
pruned, and no existing snapshot is overwritten.

## Optional user timer

`packaging/workspan-backup.service` and `packaging/workspan-backup.timer` are
optional specifications, not an installation. The daemon-backed
`workspan backup --keep N` command is wired and tested; enabling the timer still
requires separate approval.
The service only sends that request; it never opens SQLite or owns the daemon's
state/runtime directories. The timer requests one backup daily, with up to
15 minutes of jitter and a missed-run catch-up after login.

After the separate installation/enablement approval, an operator can install
these two files into the user's systemd unit directory, reload that manager and
enable `workspan-backup.timer`. This module does not perform those actions.
A service drop-in can override `Environment=WORKSPAN_BACKUP_KEEP=14` and, for a
custom daemon socket location, `Environment=WORKSPAN_RUNTIME_DIR=...`. The
snapshot directory is not configurable. `WORKSPAN_BACKUP_KEEP` is read by the
packaged unit, which passes it as `--keep`; the `workspan backup` CLI itself takes
`--keep` and ignores the variable, so a manual run is unaffected by it. Review failed requests with the user
journal for `workspan-backup.service`; a failed backup is not a successful run.

## Restore safely

1. Preserve the current ledger, its WAL/SHM files and adapter spools. Never copy
   a bare live WAL database or replace it with an old snapshot: that loses
   newly accepted evidence.
2. Copy a completed backup into a **new, explicitly named, private directory**
   for inspection. Open that copy with `WorkspanStore`, not the managed backup
   itself, so validation/restoration does not mutate the retained original.
3. Compare restored identity count, revision, bindings and each measure's totals
   at the same report boundaries. The three measures - attested, inferred attended
   and agent runtime, defined in [reports](reports.md) - remain separate; do not
   add them together. Open sessions and unresolved evidence remain uncertain.
4. Switching the daemon to a restored ledger requires separate approval and a
   plan to preserve/replay evidence accepted since the snapshot. Service stops,
   data replacement and replay are not automated by this module.

## Regression tests

The regression tests use temporary synthetic stores only and never touch a real
ledger:

```sh
export PATH=~/.local/share/workspan/bend-ci/bin:$PATH
export BEND_SOURCE_DIR=~/.local/share/workspan/bend-ci/source
bun test test/backup.test.ts
bun run check
```

Keep `BEND_EXECUTABLE` unset so the default generated policy lane is tested.
