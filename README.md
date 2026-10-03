# Workspan

Working time across tools, without counting it twice.

Workspan is the proposed independent successor to the Pi-only time-tracking interface: one local accounting core, an Omarchy shell plugin, and adapters for Pi, Codex, and other evidence sources.

## Current state

The local vertical slice exists and runs: an inherited Bend accounting core (`src/core/`, see [docs/bend.md](docs/bend.md) and [docs/provenance.md](docs/provenance.md)), a single-writer daemon over a private Unix socket, a CLI, a read-only local Codex adapter, and an Omarchy bar widget that reads the status file the daemon writes. A Pi adapter runs alongside the existing tracker in its shadow phase ([adapters/pi](adapters/pi/README.md)): it emits terminal presence and turn timing to the daemon, never opens the tracker's database, and was verified live inside a real Pi session. A Rust collector handles the desktop boundary ([docs/collector.md](docs/collector.md)): it probes which native signals this host offers, and emits coarse presence events that annotate coverage without ever becoming hours.

```sh
# The gates. Bend needs its pinned toolchain (never BEND_EXECUTABLE: that selects
# the native lane, which is a deliberate choice rather than a default).
bash scripts/install-bend-ci.sh ~/.local/share/workspan/bend-ci
export PATH=~/.local/share/workspan/bend-ci/bin:$PATH BEND_SOURCE_DIR=~/.local/share/workspan/bend-ci/source
bun run build:check && bun run proof:check && bun test && bun run check

# The slice itself.
bun src/daemon/main.ts --db /tmp/demo.sqlite --runtime-dir /tmp/demo-run &
bun src/cli/workspan.ts --socket /tmp/demo-run/workspan.sock session start --project coral
bun src/cli/workspan.ts --socket /tmp/demo-run/workspan.sock engine --check

# Notes are the one stored free-text field, and only what the user types themselves:
# bounded to one line of 200 characters, append-only, never auto-captured.

# Before any migration: classify existing receipts read-only, importing nothing.
bun src/cli/workspan.ts audit --turns exports/pi-worktime.jsonl --chunks exports/pi-worktime-chunks.jsonl --require-clean

# Migrate counted evidence into a separate target, reconciled against the source.
# Without --apply it only plans; the daemon's own database is refused.
bun src/cli/workspan.ts migrate --chunks exports/pi-worktime-chunks.jsonl \
  --tracker-db ~/.local/state/pi-time-tracker/tracker.sqlite --target /tmp/migrated.sqlite --apply
```

Nothing here imports live history, enables a service or migrates records: the daemon runs only when started by hand, and the adapter reads another application's database read-only. The widget is installed on this machine at `~/.config/omarchy/plugins/workspan.tracker` and is removable with `omarchy plugin remove workspan.tracker`. The existing [pi-time-tracker](../pi-time-tracker/README.md) remains intact and is still the installed tracker. The public repository is <https://github.com/ryan-brosas/workspan>; [packaging/](packaging/README.md) holds a daemon unit that is designed but not installed.

## Architecture and source research

Read the [proposed architecture](docs/architecture.md) for component ownership, event/acknowledgement contracts, time semantics, migration gates and the implementation acceptance ledger.

The recommended first version preserves the TypeScript/SQLite and generated Bend accounting core, hosts it in a standalone daemon, and uses Rust for native desktop collection. A Rust daemon with a prebuilt Bend engine remains an optional later packaging decision, not a reason to rewrite the accounting rules now.

[Research and ingestion receipts](docs/research-2026-10-02.md) record the seven GitHub references added to Sourcebot, verified revisions, decisions and remaining gaps. Use **`context:workspan`** for the scoped corpus; the context is live, while the design is still proposed. “Tom's version” needs confirmation before any compiler/database substitution.

## The problem

Work continues across conversations, editors, design tools, and browsers. Agent response duration is not the user's whole working session. Conversely, an agent running unattended is not evidence that the user worked that entire time.

The tracker should preserve useful interaction evidence, support explicit work sessions, show uncertainty, and prevent concurrent tools from multiplying the same hour.

## Direction

```text
Pi adapter ------------+
Local Codex adapter ---+
Dot connector ---------+--> Shared core + local storage --> Reports
Desktop signals -------+                |
Manual sessions -------+          Omarchy plugin
```

- **Core:** evidence validation, project mapping, replay-safe ingestion, interval accounting, persistence, and reports. Reuse the existing tracker's tested TypeScript/SQLite and Bend accounting where they fit; do not rewrite it for a new name.
- **Adapters:** collect source-specific metadata and expose coverage limits. They do not own separate totals or ledgers.
- **Omarchy plugin:** current project, session controls, today's breakdown, and missing-coverage status. It is the desktop interface, not the database or accounting authority.
- **Independent runtime:** tracking should continue when Pi is closed and survive an Omarchy shell reload. The exact process/IPC packaging still needs a minimal implementation decision; no background service is authorized or installed by this brief.

Keep user-attested session hours, inferred work windows, and measured agent activity separate. Never add these measures together. Within a measure, merge overlapping Pi/Codex/Dot intervals. Unknown gaps remain visible. Idle or app-focus signals alone do not prove attendance, and reading/design work can continue without typing.

## Start here

The proposed sequencing and acceptance ledger are in [the architecture](docs/architecture.md). These steps remain implementation work, not completed setup.

1. Inspect `../pi-time-tracker/` and its current tests before moving code. Choose a reuse/extraction boundary that preserves existing Pi behavior and historical records. Avoid maintaining two copies of the accounting logic.
2. Build the smallest local vertical slice: source-tagged metadata enters the shared accounting path, can be replayed safely, and produces a truthful report without Pi running.
3. Add the Omarchy interface using the supported user-plugin mechanism. Keep desktop installation separate from implementation and obtain approval before enabling it.
4. Connect Pi and local Codex through their supported interfaces. Prove metadata-only collection and project isolation before live ingestion.
5. Add Dot only after its event source and permissions are verified. Do not block the core on an unsupported private endpoint.

A package split, public API, schema migration, service, and plugin layout are implementation choices, not established features. Keep the first slice small.

## Dot is a separate integration

Read the [verified Dot/Codex investigation](docs/dot-time-tracking-research-2026-10-02.md) before choosing a connector. It includes source evidence, limitations, and proposed acceptance checks.

The open question is whether the intended Dot account is personal or an eligible enterprise-managed workspace. Ordinary local Codex hooks do not capture Dot cloud orchestration. A desktop plugin does not remove that boundary.

The existing tracker research is grounded in commit `931c74c024a24ae7800a66fe21bccecbf19a945b`; recheck the working tree before implementation. Temporary extraction paths in the research note are diagnostic evidence, not runtime dependencies.

## What the first implementation must prove

- Repeated imports do not duplicate evidence or hours.
- Concurrent sources count once within the same accounting measure.
- Human-origin signals remain distinguishable from background agent activity.
- Long gaps, missing ends, disconnections, and unavailable sources are explicit.
- Projectless/cloud work is not automatically assigned to CoralBricks or another client.
- No prompts, replies, screenshots, window titles, browsing URLs, credentials, or customer payloads are stored by default.
- Restarting the UI does not lose or duplicate the session.
- Existing Pi reports and records remain usable.

These are acceptance criteria, not completed tests. Nothing in this folder authorizes changing official hours or automatically submitting a timesheet.
