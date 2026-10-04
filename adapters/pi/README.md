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

Events are appended to a private spool (`~/.local/state/workspan/pi-spool-<pid>.jsonl`,
0600 in a 0700 directory) and then delivered over the daemon socket. The transport and
the spool rules live in `src/spool.ts`, shared with the CLI and `workspan mcp`, so
this adapter cannot drift from `docs/protocol.md`. Delivery is at-least-once and the
daemon dedupes by identity, so replay is safe; if the daemon is down, the spool holds
the evidence and drains on the next emit or on the next session start. A spool left by
a dead Pi process is drained by the next one. If the spool exceeds 10 MB the adapter
stops appending and warns once instead of silently dropping evidence.

## Try it once, without installing anything

```sh
bun src/daemon/main.ts --db /tmp/trial.sqlite --runtime-dir /tmp/trial-run &
pi -e /mnt/ssd/work/project/workspan/adapters/pi -p "reply with the word ok"
sqlite3 /tmp/trial.sqlite "select kind, origin, count(*) from observations group by 1,2"
```

It is installed in Pi's `packages` list (`/mnt/ssd/work/project/workspan/adapters/pi`,
added 2026-10-04, still in the shadow phase): a Pi restart or `/reload` is what loads
it into a running session.

## Multiple terminals and sessions

Each Pi terminal is its own process, so two terminals are two adapter instances with
separate identities from the start — a Herdr pane per project needs no configuration.
Within one process, sessions change: switches, automation, resumed work.

| Situation | What the adapter does |
| --- | --- |
| A new session starts | Its root is recorded under its own session id; the previous session's is untouched |
| Terminal input | Attributed to whichever session is **live at that moment** — one handler, registered once, reads the live session rather than capturing the first one |
| A switch is proposed | Only the spool is drained; a switch can be vetoed, so state survives it |
| A session shuts down | Its root is forgotten; a late event from another session is unaffected |

Concurrent sessions in different projects produce separate windows and separate
attribution. If two sessions overlap in time *and* claim different projects, the
overlapping segment is reported as ambiguous for review rather than split or
doubled — one hour is never billed to two clients automatically.

Verified live: two nested Pi sessions, two repositories, one trial daemon — two
distinct session ids, two roots, and agent runtime attributed to each project from
its binding.

## Coexistence

Both the tracker and this adapter observe the same Pi sessions during the shadow
phase. That is intentional: **their ledgers must never be added together**. The
tracker's database and Workspan's are separate until the cutover removes one writer,
per the architecture's migration sequence.
