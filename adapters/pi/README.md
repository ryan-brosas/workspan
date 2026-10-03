# Workspan Pi adapter

A Pi extension that runs **alongside** the installed tracker during the shadow phase:
it never opens the tracker's database, never writes its ledgers, and emits Workspan
evidence only.

## What it emits

| Observation | Evidence | Measure |
| --- | --- | --- |
| Human keystrokes in the Pi terminal | `interaction`, origin `human`, one per 10s bucket | inferred attended windows |
| Turn start / settlement | `agent-start` / `agent-end`, origin `automated` | agent runtime |
| A settled turn also emits presence | `interaction` at settlement | the session stays open while the human reads |

It never emits prompts, tool payloads, titles, or a client name. The workspace root
is derived by walking up to `.git`; **attribution is resolved by the daemon from
bindings**, because an adapter that named a client would be guessing it.

## Delivery

Events are appended to a private spool (`~/.local/state/workspan/pi-spool.jsonl`,
0600 in a 0700 directory) and then delivered over the daemon socket. Delivery is
at-least-once and the daemon dedupes by identity, so replay is safe; if the daemon
is down, the spool holds the evidence and drains on the next emit. If the spool
exceeds 10 MB the adapter stops appending and warns once instead of silently
dropping evidence.

## Try it once, without installing anything

```sh
bun src/daemon/main.ts --db /tmp/trial.sqlite --runtime-dir /tmp/trial-run &
pi -e /mnt/ssd/work/project/workspan/adapters/pi -p "reply with the word ok"
sqlite3 /tmp/trial.sqlite "select kind, origin, count(*) from observations group by 1,2"
```

Making it permanent means adding it to Pi's `settings.json`, which changes agent
configuration — a separate, explicit step.

## Coexistence

Both the tracker and this adapter observe the same Pi sessions during the shadow
phase. That is intentional: **their ledgers must never be added together**. The
tracker's database and Workspan's are separate until the cutover removes one writer,
per the architecture's migration sequence.
