# Workspan

Working time across tools, without counting it twice.

Workspan is the proposed independent successor to the Pi-only time-tracking interface: one local accounting core, an Omarchy shell plugin, and adapters for Pi, Codex, and other evidence sources.

## Current state

This repository holds a project brief and research handoff, not a runnable application. No service, plugin, connector, or migration has been implemented or installed here. The existing [pi-time-tracker](../pi-time-tracker/README.md) remains intact and is still the installed implementation. The public repository is <https://github.com/ryan-brosas/workspan>; [packaging/](packaging/README.md) holds a daemon unit that is designed but not installed.

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
