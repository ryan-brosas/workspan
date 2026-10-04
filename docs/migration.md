# Migrating the existing tracker

M5-shaped migration of `pi-time-tracker` into a Workspan database. It has been run
end to end on this machine; what has **not** happened is switching over — the live
tracker is still the installed one.

## What it reads, and what each source becomes

| Source | Becomes | Why |
| --- | --- | --- |
| `pi-worktime-chunks.jsonl` | agent runtime | a Pi turn running is not proof anyone attended |
| tracker `windows` (`kind='work'`) | inferred attended windows | these windows *are* the tracker's evidence for inferred attendance; re-deriving them from synthesised keystrokes would invent input that never happened |
| tracker `workspaces` | project bindings | the tracker's own attribution, imported rather than invented, keeping its `explicit` flag |
| tracker `windows` (`kind='gap'`) | nothing | a gap is the record of excluded time; the union already treats it as absence |
| `pi-worktime.jsonl` summaries | audited only | they describe durability, not time; importing them with the chunks would count the same minutes twice |

Task labels are read where receipt identity needs them and never printed.

## Commands

```sh
# Audit first: refuse to migrate a scope whose receipts need review.
bun src/cli/workspan.ts audit --turns exports/pi-worktime.jsonl \
  --chunks exports/pi-worktime-chunks.jsonl --require-clean

# Plan; nothing is written and the target is not created.
bun src/cli/workspan.ts migrate --chunks exports/pi-worktime-chunks.jsonl \
  --tracker-db ~/.local/state/pi-time-tracker/tracker.sqlite --target /tmp/migrated.sqlite

# Apply, then read the result.
bun src/cli/workspan.ts migrate --chunks exports/pi-worktime-chunks.jsonl \
  --tracker-db ~/.local/state/pi-time-tracker/tracker.sqlite --target /tmp/migrated.sqlite --apply
bun src/cli/workspan.ts --socket /tmp/run/workspan.sock projects
```

## Safety properties

- The target is explicit, and the daemon's own database is refused unless
  `--allow-live-database` is passed.
- Without `--apply` it plans only: verified that the target file is not created.
- Replay is idempotent: chunk identities come from turn ids and chunk ordinals,
  and window identities come from the tracker's own window ids, so a second run
  adds nothing.
- Every scope is migrated with an explicit mapping or left unallocated.

## Reconciliation

The source evidence and the imported evidence are both unioned by Bend and compared.
A migration that does not reconcile is reported as failed.

Result on this machine:

```
agent     source 21,196,821 ms   target 21,196,821 ms   equal
inferred  source 260,561,795 ms  target 260,561,795 ms  equal

written: 5,094 events, 758 windows, 13 bindings, 0 conflicts
```

The inferred figure is the honest one to compare against a naive sum: the tracker's
work windows overlap, and only the union is a defensible duration.

## Attribution, and what is still provisional

All 13 imported bindings carry `explicit = 0`: the tracker derived those names from
directory names, so Workspan reports them as **provisional** rather than presenting
`tmp`, `utopia`, `repo` or `website` as clients someone chose. Confirming a binding
is a correction — an explicit, reversible action — and it is now implemented:
`workspan projects confirm <root>` keeps the derived label and marks it explicit, and
the status payload lists unallocated time per root so the desktop surface can offer it.

## Still open

- **Reallocating already-migrated history.** A provisional label can now be confirmed
  and an unallocated breakdown by root is in the status payload, but moving time that
  was already imported under a provisional label is still a correction nobody can make.
- **The Pi adapter is new.** It exists and is installed in shadow mode (`adapters/pi`),
  so Pi evidence no longer depends on the tracker; the tracker still holds the history
  that has not been imported.
- **Retiring the old writer** waits on the shadow window and a reconciled import range
  (see [cutover](cutover.md)).
