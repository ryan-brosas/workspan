<div align="center">

# Workspan

**Working time across tools, without counting it twice.**

_One local accounting core for attested sessions, agent runtime and presence._

<p>
  <img src="assets/cover.png" alt="Blue clock and Workspan wordmark" width="960">
</p>

[![checks][checks-badge]][checks]
[![release][release-badge]][releases]
[![License: MIT][license-badge]](LICENSE)

</div>

Workspan keeps the working time you attest to, the time your agents ran, and the
presence signals around them as three separate measures on one local accounting
core. A daemon owns the database; a CLI and an Omarchy bar widget are its
clients; the interval arithmetic is generated Bend policy with proof obligations
that gate CI. Nothing leaves the machine.

## Why Workspan?

| | Capability | What it unlocks |
| :-: | --- | --- |
| 🧾 | **Attested sessions** | One keypress or one click says what the time was for. Notes are the only free text, and only what you type. |
| 🤖 | **Agent runtime, kept honest** | Pi, Codex, opencode and Claude Code timing is its own measure — an agent running is never proof anyone was at the desk. |
| 🔗 | **One writer, one total** | The daemon owns the database; the CLI, the widget and every adapter are clients, so totals cannot fork. |
| 🧮 | **Provable arithmetic** | Interval unions and gap rules live in Bend policy pinned by digest, with stated laws proven in CI. |
| 🔒 | **Metadata only** | No prompts, replies, titles, URLs or tool payloads — in the database, the spools, the status file or the logs. |
| 🧩 | **Harness-agnostic** | Each agent history is a reader behind one contract; a missing store reports unavailable, never zero. |

## The three measures

Attested sessions, inferred attended windows and agent runtime are different
kinds of evidence about the same day, and they are never added together.

| Measure | What it is | What it is not |
| --- | --- | --- |
| **Attested** | Sessions you started and stopped, with optional one-line notes. | Never inferred from activity you did not confirm. |
| **Inferred attended** | Windows where you were demonstrably at the machine (Pi presence ticks; desktop signals as annotations). | An agent running, a window focused or a file open. |
| **Agent runtime** | Turn timing from Pi, Codex, opencode and Claude Code histories. | Attendance, or billable time. |

Within a measure, overlapping intervals are unioned and a long idle gap stays
Unknown instead of becoming work. Removals and corrections are recorded, never
silently rewritten.

## The daily loop

```sh
workspan session toggle --project coral   # start or stop; attribution comes from bindings
workspan note "reviewed the auth flow"    # the one free-text field, authored by you
workspan note --idle "lunch with client"  # answer the popup nudge on the session the stretch fell in
workspan session start --at 09:10         # correct a boundary afterwards; the day marks it
workspan day                              # sessions, notes, pauses and the three measures
workspan week --date 2026-10-03 --tz UTC  # local Monday–Sunday containing the date
workspan day --json                       # exact millisecond facts, not rounded labels
workspan week --export csv > week.csv     # also --export md; review, never automatic billing
workspan backup --keep 7                  # private daemon-owned SQLite snapshot
```

A native collector runs as a user service and writes coarse presence - focus changes,
idle-inhibit, seat idle - into the ledger as annotations; none of it becomes hours, and
a session boundary or a stretch can only be corrected by you (`--at`, `note --idle`),
never automatically. On the desktop, the Omarchy bar widget shows the running clock and a popup with
start/stop, the company picker and the current measures; one caption nudges when
the ChatGPT Dot profile was recently active and nothing is being tracked, and another
reports a finished stretch with no seat input. The idle caption pauses nothing: the
collector annotates, and only you decide whether that stretch was a break. A third
caption names the time no measure covers ("today has no evidence"), which is the
review list for gaps you can attest afterwards.

Harnesses integrate through one contract, not five: `docs/protocol.md` and
`src/client.ts` own the transport, and the adapters only decide what an observation
means. `workspan doctor` answers whether the daemon, the status file, the collector
unit, its spool, the ingest loop's heartbeat, the adapter spools and every evidence
source are actually wired, and `workspan mcp`
exposes the same daemon to an agent as read-mostly tools.
Attribution derives from the focused workspace (Herdr's focused pane, then the
window's process tree) and resolves client names only from explicit bindings —
a confirmation line on stderr says what a session was attributed to.

## Reporting and delivery

Day and week share one attributed projection and Bend totals. Open sessions stay
provisional, overlaps between clients stay ambiguous, and collection gaps remain
visible. CLI/MCP exports page an immutable snapshot instead of exceeding the socket
frame limit. [Report semantics](docs/reports.md) describe JSON/CSV/Markdown and
[delivery recovery](docs/delivery.md) describes bounded spools, retry and refusals.
[Backups](docs/backup.md) preserve a consistent ledger and prune only validated
managed backup files, never evidence. The optional backup timer
(`packaging/workspan-backup.timer`) is packaged, not enabled by default.

Binding confirmation changes future ingestion only; immutable-source replay across
binding changes, audited history corrections/undo and attribution review in the
popup are still open. Live import, retiring the other writer and official hours
remain separately approved. [Cutover](docs/cutover.md) tracks what is open.

## Harnesses

```sh
workspan harness                        # every reader: store, freshness, staleness
workspan ingest-harness --since-days 7  # backfill further than the automatic window
```

| Reader | Source |
| --- | --- |
| Pi | live adapter, installed in shadow mode: presence ticks, turn timing, settle boundaries |
| Codex | `~/.codex/thread_history_*.sqlite` turn timing |
| opencode | `opencode.db` message blocks per session |
| Claude Code | `~/.claude/projects/**/*.jsonl` turns |

Each reader is read-only, timing-only and replay-safe: running an import twice
adds nothing. A store that is missing, stale or of an unknown shape is reported
as unavailable rather than as zero activity.

Detection is automatic. The daemon probes every reader when it starts and every
five minutes after that, imports what it finds, and records each pass in
`status.json` under `harness`: the store found, how stale it is, and how many
records were accepted, duplicated or conflicted. `available: false` is a store
that was not found, and a reader that fails is named without hiding the others.
`doctor` checks the pass is still running, and
`workspan harness` prints the live probe next to the last automatic pass. The
entry point takes `--harness-poll-ms` for the poll cadence (minimum one second) and
`--harness-window-ms` for how far back each pass reads (minimum one minute, default
seven days), plus `--spool-dir` for the spool location, and `--no-harness` to switch
detection off; the daemon library default is off, so a scratch daemon never reads
live histories.

### Live adapters

| Adapter | Surface | State |
| --- | --- | --- |
| Pi | in-process extension (`adapters/pi`) | installed in Pi's `packages`, shadow phase, delivering |
| opencode | plugin (`adapters/opencode`) | installed in `opencode.json`; observed delivering on 2026-10-04; plugin changes need an app-server restart |
| Claude Code | hooks (`adapters/claude/hook.ts`) | installed for UserPromptSubmit / Stop / SubagentStop / SessionEnd |
| Codex | none confirmed | no supported live hook verified for the installed CLI; the inspected manifest is not proof of universal hook absence, so the history reader stays the Codex lane |

An adapter emits only `{ root, session, at, kind, origin }` through `src/client.ts`,
and the daemon resolves attribution. None of them starts a session: attestation is the
person's, and a queued prompt is presence of unknown origin rather than attendance.

## How it fits

```text
Pi adapter --------+                                +--> day/week reports / status.json
Codex history -----+                                |
opencode history --+--> daemon (the only writer) ---+--> Omarchy bar widget
Claude transcripts +       SQLite ledger           |
desktop collector -+       Bend policy             +--> CLI (status, day, session, ...)
manual sessions ---+
```

## Development

Requires Bun, Node >= 22.19.0, and the pinned Bend toolchain for the gates. Never
set `BEND_EXECUTABLE` — it selects the native lane, and the tests asserting the
default lane are meant to see generated policy.

```sh
bash scripts/install-bend-ci.sh ~/.local/share/workspan/bend-ci
export PATH=~/.local/share/workspan/bend-ci/bin:$PATH BEND_SOURCE_DIR=~/.local/share/workspan/bend-ci/source

bun run build:check   # generated policy matches its .bend sources
bun run proof:check   # every stated audit law is proven
bun test              # policy, lanes, daemon, adapters, widget helpers
bun run check         # types
```

The daemon runs by hand during development, or as the packaged unit
([packaging](packaging/README.md)):

```sh
bun src/daemon/main.ts --db /tmp/demo.sqlite --runtime-dir /tmp/demo-run &
bun src/cli/workspan.ts --socket /tmp/demo-run/workspan.sock session start --project coral
bun src/cli/workspan.ts --socket /tmp/demo-run/workspan.sock engine --check
```

## Privacy boundary

Workspan stores metadata: timestamps, source/session identities, workspace roots,
bindings, and the notes you type yourself (one line, at most 200 characters,
append-only). It never stores prompts, replies, window titles, URLs, tool
payloads or credentials, and the collectors read coarse fields only. Local
application caches are versioned observations, not supported APIs: their shape is
validated, and a changed shape is reported as unavailable.

## Docs

- [Architecture and acceptance](docs/architecture.md)
- [Why the tracker misses hours](docs/missing-hours.md)
- [Bend accounting core](docs/bend.md) and [provenance](docs/provenance.md)
- [Desktop collector](docs/collector.md) and [evidence recovery](docs/delivery.md)
- [Day/week exports](docs/reports.md), [backups](docs/backup.md) and [cutover gates](docs/cutover.md)
- [Dot and Codex feasibility research](docs/dot-time-tracking-research-2026-10-02.md)

## License

MIT — see [LICENSE](LICENSE).

[checks-badge]: https://img.shields.io/github/actions/workflow/status/ryan-brosas/workspan/ci.yml?branch=main&style=for-the-badge&label=checks
[release-badge]: https://img.shields.io/github/v/release/ryan-brosas/workspan?style=for-the-badge&label=release
[releases]: https://github.com/ryan-brosas/workspan/releases
[checks]: https://github.com/ryan-brosas/workspan/actions/workflows/ci.yml
[license-badge]: https://img.shields.io/badge/license-MIT-2ea44f?style=for-the-badge
