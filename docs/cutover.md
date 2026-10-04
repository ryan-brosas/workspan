# Cutover: retiring the old tracker's writer

Two ledgers exist during the shadow phase: `~/.local/state/pi-time-tracker/tracker.sqlite`
(the installed tracker, still written by its Pi extension) and Workspan's
`~/.local/state/workspan/workspan.sqlite`. **They are never added together**, and
nothing here authorises the migration.

## Where the comparison stands (2026-10-04)

```
day         tracker work  ws inferred  ws attested  ws agent  inferred - tracker
2026-10-04  375m          0m           0m           0m        -375m
2026-10-03  561m          0m           0m           0m        -561m
2026-10-02  328m          0m           0m           0m        -328m
2026-10-01  905m          0m           0m           0m        -905m
```

Reproduce with `bun scripts/reconcile-tracker.ts --days 7`. The tracker's `work`
windows and Workspan's inferred measure are the comparable pair: both are
interaction-derived windows under the same idle-gap semantics. The script is
read-only on both sides - the tracker's ledger is opened `readOnly: true`, and the
Workspan numbers come from the daemon's own day report, because a client must not open
the accounting database.

The gap in the columns is expected, not a defect: Workspan holds no *historical*
interaction evidence. Its live Pi adapter was installed on 2026-10-04 (3 events and
~3.3 s of agent runtime that day), and the tracker's history has not been imported.

## What must be true before the old writer is retired

1. The Pi adapter has run in shadow long enough to produce a like-for-like window of
   days. It is installed in Pi's `packages`; a Pi restart or `/reload` is what loads it
   into a running session.
2. The tracker's history is imported through the sanctioned path, which keeps the
   tracker's own attribution and leaves unconfirmed labels provisional:
   `workspan migrate --tracker-db ~/.local/state/pi-time-tracker/tracker.sqlite --chunks <file> --target <db>`
   (it plans first; `--apply` is a separate, explicit step).
3. The imported range reconciles: for each imported day, the inferred column matches the
   tracker's work column within rounding and explainable gap differences.
4. Only then is the old extension's write path removed, and its ledger kept read-only
   as provenance.

## Status

Pending: steps 1 and 2. Step 3 is measured by the script above and step 4 is the
decision this document exists to gate. The migration imports history into an explicitly
named target and touches the provenance of the live ledger, so it needs its own
approval before it runs.
