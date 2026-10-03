<div align="center">

# Workspan

**Working time across tools, without counting it twice.**

_One local accounting core for attested sessions, agent runtime and presence._

<p>
  <img src="assets/cover.png" alt="Blue clock and Workspan wordmark" width="960">
</p>

[![checks][checks-badge]][checks]
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
workspan day                              # sessions, notes, pauses and the three measures
```

On the desktop, the Omarchy bar widget shows the running clock and a popup with
start/stop, the company picker and the current measures; a caption nudges when
the ChatGPT Dot profile was recently active and nothing is being tracked.
Attribution derives from the focused workspace (Herdr's focused pane, then the
window's process tree) and resolves client names only from explicit bindings —
a confirmation line on stderr says what a session was attributed to.

## Harnesses

```sh
workspan harness                        # every reader: store, freshness, staleness
workspan ingest-harness --since-days 7  # import agent runtime from local histories
```

| Reader | Source |
| --- | --- |
| Pi | live extension: presence ticks and turn timing |
| Codex | `~/.codex/thread_history_*.sqlite` turn timing |
| opencode | `opencode.db` message blocks per session |
| Claude Code | `~/.claude/projects/**/*.jsonl` turns |

Each reader is read-only, timing-only and replay-safe: running an import twice
adds nothing. A store that is missing, stale or of an unknown shape is reported
as unavailable rather than as zero activity.

## How it fits

```text
Pi adapter --------+                                +--> day report / status.json
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
- [Desktop collector](docs/collector.md)
- [Dot and Codex feasibility research](docs/dot-time-tracking-research-2026-10-02.md)

## License

MIT — see [LICENSE](LICENSE).

[checks-badge]: https://img.shields.io/github/actions/workflow/status/ryan-brosas/workspan/ci.yml?branch=main&style=for-the-badge&label=checks
[checks]: https://github.com/ryan-brosas/workspan/actions/workflows/ci.yml
[license-badge]: https://img.shields.io/badge/license-MIT-2ea44f?style=for-the-badge
