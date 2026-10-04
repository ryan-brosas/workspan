# Evidence delivery and recovery

`src/client.ts` owns transport, batching and the durable evidence spool for every
harness. Appends are validated against the shared metadata allowlist before
writing; content fields are refused without being spooled. A valid append is written
and synced before delivery. A drain atomically rotates the active file into
`.pending`, or durably combines a pre-existing pending snapshot with already queued
active records before clearing active. A crash in that combination can replay, never
erase, evidence. Per-record receipts retire every acknowledged record through a
synced atomic replacement: accepted, duplicate and conflict alike. A conflict is an
acknowledgement - the daemon stored that record in its review table - so resending
it could never change the outcome, and keeping it would pin every later observation
behind it. Malformed legacy records have no receipt and stay queued for review. Lost responses or a crash before cleanup
replay the same identities. An explicit flush covers evidence already queued when
called; later appends may join the following snapshot and retire only after acknowledgement.

Batches are bounded by UTF-8 bytes and count so both requests and receipt frames
stay under the 64 KiB protocol limit. CLI imports and the desktop ingest shim use
the same batcher. The CLI import prints a conflict and exits nonzero, so the
collector's ingest loop keeps its few bytes: a collector line that conflicts needs a
person. The adapter spool retires the same record once the daemon receipts it, which
is what lets a lane recover on its own; the daemon's review table, `coverage.conflicts`,
the day/week `conflicting_evidence` warning and a `doctor` check keep it visible.
Malformed or oversized evidence is retained, never discarded.

A live producer retries pending delivery every 15 seconds. The daemon recovers dead
producers at startup and on its status heartbeat, without waiting for a new harness
session. Its default recovery directory is beside **its own database**; a scratch
daemon therefore cannot consume the installed user's evidence. The entry point
honors `WORKSPAN_SPOOL_DIR` for an explicitly configured directory. The daemon still
owns the only database writer; recovery is an IPC client, not a second ledger.

Recovery claims a writer family, not each sibling independently. It chooses the
same pending-first anchor across drainers and renames it atomically. The new filename
retains the original writer PID and adds `recovery-owner-<drainer PID>-<UUID>`, so the
remaining active sibling stays in the same family even if the drainer crashes between
renames. A live owner excludes the whole family from other drainers. Pending drains
before active; event receipt counts alone would not prove chronological attendance
was preserved. Ambiguous legacy families with more than two snapshots remain for
review rather than guessing their order. Live producers' files are never claimed.
Empty files can be removed, but undelivered bytes cannot. Temporary replacement
files are not independent evidence; `.pending` remains replayable until replacement.

`.error` files report delivery failures and clear after successful recovery. `.loss`
files report refused appends (full spool, invalid metadata or write failure) and **remain for manual
review**, because no successful retry can reconstruct an observation that was never
stored. Both contain only coarse error code and timestamp. `doctor` and status
`delivery` counters make this uncertainty visible; reports carry review warnings.
Never delete nonempty spools or clear refusal markers merely to make doctor green.
If storage cannot even write a marker, a bounded metadata-only notification/stderr
message is the fallback. Spool size defaults to 10 MiB; an append that would exceed
it is refused visibly, not allowed to overshoot it.

Pi tick identities are versioned (`tick-v2-<bucket>`) with timestamps aligned to the
same ten-second bucket. Repeated ticks in one bucket now have identical metadata,
not conflicting fingerprints. Tick precision is ten seconds. The versioned token
avoids rewriting or colliding with earlier `tick-<bucket>` records; old spooled
records retain their original identity and timestamp.

## Still open

Binding changes can still cause a replayed unallocated event to conflict because
resolved attribution is part of its stored fingerprint. Separating immutable source
metadata from attribution, including compatibility for existing rows, belongs to
the pending attribution-correction work. Such a replay is now receipted as a
conflict, recorded for review and retired from the queue instead of pinning it; the
stored hours keep their original attribution. This is a cutover blocker, not a
reason to rewrite existing ledger records without an audited correction plan.

The desktop runtime spool survives daemon restarts through
`RuntimeDirectoryPreserve=yes`; it is not durable across logout/reboot. A future
collector state-spool move needs its own host deployment and recovery test. The past
collector outage cannot be reconstructed honestly from other activity.
