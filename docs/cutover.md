# Cutover: retiring the old tracker's writer

Two ledgers exist during the shadow phase: `~/.local/state/pi-time-tracker/tracker.sqlite`
(the installed tracker, still written by its Pi extension) and Workspan's
`~/.local/state/workspan/workspan.sqlite`. **They are never added together**, and
nothing here authorises the migration.

## Where the comparison last stood (2026-10-04, adapters live)

```
day         tracker work  ws inferred  ws attested  ws agent  inferred - tracker
2026-10-04  398m          9m           0m           8m        -389m
2026-10-03  561m          0m           0m           0m        -561m
2026-10-02  328m          0m           0m           0m        -328m
```

This is a historical rounded observation made before reporting/reconciliation
repairs; do not use it as an exact gate or assume the current command reproduces
it. After an approved deployment, remeasure with
`bun scripts/reconcile-tracker.ts --days 7`. The tracker's `work`
windows and Workspan's inferred measure are the comparable pair: both are
interaction-derived windows under the same idle-gap semantics. The script is
read-only on both sides - the tracker's ledger is opened `readOnly: true`, and the
Workspan numbers now come from exact daemon JSON reports; source windows are
clipped at local calendar boundaries and unioned through Bend. The table above was
captured as rounded minute labels, not exact values rounded for display; the script
prints exact milliseconds. Because Workspan's side comes from the daemon's report
rather than its database file, a client must not open the accounting database.

The gap is expected and now shrinking: Workspan's inferred measure covers only what the
live adapters have seen (the Pi extension, the opencode plugin and the Claude hook all
started delivering on 2026-10-04), and the tracker's history has not been imported.

### The import is planned, not run

The rehearsal is a single read-only command:

```sh
bun run src/cli/workspan.ts migrate --chunks ~/.agents/exports/pi-worktime-chunks.jsonl \
  --tracker-db ~/.local/state/pi-time-tracker/tracker.sqlite --target /tmp/ws-migrate-plan.sqlite
```

It answers with a plan and leaves nothing behind (`written: null`, `reconciliation:
null`, no target file). `--apply` is the step that needs the approval, and step 3 above
is what judges it.

## What must be true before the old writer is retired

1. The Pi adapter has run in shadow long enough to produce a like-for-like window of
   days. It is installed in Pi's `packages`; a Pi restart or `/reload` is what loads it
   into a running session.
2. The tracker's history is imported through the sanctioned path, which keeps the
   tracker's own attribution and leaves unconfirmed labels provisional:
   `workspan migrate --tracker-db ~/.local/state/pi-time-tracker/tracker.sqlite --chunks <file> --target <db>`
   (it plans first; `--apply` is a separate, explicit step).
3. The imported range reconciles: for each imported day, the inferred column matches the
   tracker's work column in exact clipped milliseconds, with only explainable gap differences.
4. Only then is the old extension's write path removed, and its ledger kept read-only
   as provenance.

## Status

Local reporting/export and consistent-backup implementation is complete. That is not
approval to deploy, to enable the optional backup timer
(`packaging/workspan-backup.timer`), to import live history or to retire the old
writer; each of those stays separately approved. Binding-change replay, auditable
history corrections/undo and popup attribution review still block cutover. Back up
both ledgers and rehearse preserving newly accepted evidence during rollback, in an
explicit isolated target.

Pending: steps 1 and 2. Step 3 is measured by the script above and step 4 is the
decision this document exists to gate. The migration imports history into an explicitly
named target and touches the provenance of the live ledger, so it needs its own
approval before it runs.
