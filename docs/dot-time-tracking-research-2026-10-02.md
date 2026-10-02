# Dot and Codex time-tracking feasibility

Research date: October 2, 2026, Seattle time. Read-only investigation for including the user's CoralBricks work in the existing tracker. No hours imported, timers started, settings changed, or external records written. No credentials or conversation bodies were collected.

## Bottom line

The installed app can identify Dot profiles and their cloud messaging rooms. That does not mean the Pi tracker currently observes Dot interactions. A local Codex-history importer alone would miss current Dot activity on this machine.

There is an officially documented cloud hook route for eligible enterprise-managed setups. Ordinary personal/local Codex hooks do not cover Dot cloud orchestration. Account/workspace eligibility and the required human-origin event coverage are not yet verified.

## Direct evidence

Installed application: `chatgpt-26.928.21956`; bundled executable reports `codex-cli 0.159.2`.

### Local Codex history

- `~/.codex/state_5.sqlite` contains 197 indexed threads; the latest recorded update in the inspected snapshot was September 22, 2026, 14:59:56 UTC.
- `~/.codex/thread_history_1.sqlite` contains 256 turns. All have a start; 250 have an end, and six are open/incomplete. No inspected interval had its start after its end. Its latest turn start was September 22, 14:59:48 UTC.
- `thread_turns` exposes `thread_id`, `turn_id`, `started_at`, `completed_at`, and `duration_ms`. `thread_items` exposes `created_at_ms` and `item_type` separately from `item_json`. Bodies were not selected.
- Both databases are historical evidence here, not proof of current Dot coverage. The earlier absence of CoralBricks cwd matches in this index does not establish absence of current CoralBricks work in the app.
- The installed protocol supports `thread/list`, `thread/read`, `thread/turns/list`, and `thread/items/list`. `thread/turns/list` accepts `itemsView: "notLoaded"`; turn timing is optional and uses Unix seconds. No authenticated protocol history request was issued.

### Current Dot metadata

In `~/.codex/.codex-global-state.json`, `electron-persisted-atom-state` contains a `cloud-aeon-sidebar-cache-v1` cache. The inspected cache was refreshed October 2 at 17:30:20 UTC. It had five profiles with `aeon_kind: "orbit"`, each linked to a messaging room. This is a profile count, not a count of attended work sessions.

Profiles expose `active_root_thread_id` and `messaging_room_id`. The cached thread objects contain no turn history in this snapshot. `orbit-activity-snapshots-v1` contains an empty data collection. Room previews retain only a latest-item timestamp and preview, not an append-only human interaction log. Preview text was not read.

The app also persists `thread-user-activity-times-v1`. Packaged code keeps the latest timestamp per host/thread and prunes old values relative to the local day when updated. The inspected map held one timestamp from September 30. At least one caller records notification replies. It is not demonstrated to cover ordinary Dot chat or every interaction, and cannot supply a complete historical timesheet.

### Packaged cloud path

The installed app's Dot setup sets `isOrbit` and uses the durable/cloud path. Static packaged code maps Dot profiles to messaging rooms and reads history through:

- `GET /tbo` and `GET /tbo/by-thread/{thread_id}` for profile lookup.
- `GET /messaging/rooms/{room_id}/messages` with `before`, `after`, `limit`, and optional reply-root pagination.

These are internal client routes, not a verified public integration contract. Message retrieval includes bodies; no metadata-only selector was found in the inspected caller. Opening the normal room flow can also mark messages read, and setup paths can create a missing room. None of those live operations was called. No auth tokens, cookies, or share links were extracted.

Static modules were inspected from the installed archive using native CLI tools, not executed. Their extracted SHA-256 checks matched archive metadata:

- `app-initial-47b07e923fcc.js`: `7a0af83e6ba47b9bf48955704299f202d0c652b95dc7247d9137993d8fd2a952`
- `app-shared-9422db8faa3a.js`: `f1530448ea1d09cef52d488383b6bd7c813128ceb655a620b54c143e56bd6351`

Temporary public/static evidence and generated protocol schemas: `/tmp/dot-tracker-research.QPLGUO/`. These are not an installed integration or a durable dependency.

## Supported collection routes

Official documentation distinguishes these cases:

| Surface | Documented route | Limit |
| --- | --- | --- |
| Local-only Codex / Work | Trusted lifecycle hooks, including MCP-tool hooks, and local history | Does not automatically cover Dot's cloud coordinator |
| Eligible enterprise Dot setup | Admin-managed remote MCP hooks under Global requirements, when managed policy and remote hooks are enabled | Personal accounts do not have these enterprise hooks; required event delivery must be tested |
| Dot cloud orchestration | Local executor OTel can record supported execution events | It does not receive cloud orchestration events |
| Analytics API | Programmatic usage aggregates | Usage counts are not attended work-session intervals |
| Compliance API | Authorized supported audit records | Not a personal productivity timer; requires separate permissions and appropriate purpose |
| Platform Agents API traces | Traces for API-created sessions in the relevant API project | Not evidence that consumer Dot conversations are available through an ordinary API key |

MCP hooks can template only required event fields, avoiding forwarding prompts and tool arguments. They use an existing connection, do not create or reconnect servers, and can be missed when the server is unavailable. `SessionEnd` MCP hooks are unsupported. No hook setup was changed or tested in the user's Dot account.

## Existing tracker integration boundary

Repository: `/mnt/ssd/work/project/pi-time-tracker`, clean working tree at `931c74c024a24ae7800a66fe21bccecbf19a945b` during inspection. Sourcebot supplied a scoped implementation review; decisive exports, persistence, report grouping, and call sites were checked locally.

- `index.ts` exports `ProjectStore`, `AutomaticClock`, and `buildAutomaticReport`.
- `project-store.ts` provides `save()` on the exported store class. Its same-ID upsert is not a complete import cursor/deduplication protocol.
- `automatic.ts` builds evidence-bounded windows; feeding older history back into its live clock triggers backward-clock handling. Do not treat it as a ready-made replay importer.
- `report.ts` already keeps agent-turn union, user-attested sessions, and inferred windows separate. Imported human-interaction evidence can join the appropriate inferred interval group, preserving overlap union with Pi. Autonomous Dot runtime must not be promoted into human-work evidence.
- `extension.ts` assembles the existing `work_report` with automatic-window evidence. No second timesheet system is needed.
- New ingestion needs source/event identity, replay-safe checkpoints, explicit project binding for cloud sessions, and coverage diagnostics. A schema migration or an additional report group is not automatically required; decide from the final evidence model rather than adding them speculatively.

## Recommended next step

First establish whether Dot is in a personal ChatGPT account or an eligible company-managed enterprise workspace. Do not infer that from the existence of cloud metadata.

If enterprise-managed, prove one metadata-only, non-blocking MCP event receipt using supported configuration and explicit admin approval. Confirm human-authored interactions can be distinguished from scheduled wakeups and delegated activity before connecting it to inferred work windows.

If personal, ordinary `~/.codex/hooks.json` is not a Dot solution. Automatic Dot coverage needs a separately approved app-side metadata integration or a supported export/event surface. The discovered internal messaging routes establish feasibility, not permission or a stable API. Until such a feed is verified, keep Dot session time user-attested instead of silently missing it or inventing it.

For implementation, preserve UTC timestamps, source account/session/event identifiers, event kind, and an explicit project assignment. Avoid prompt, reply, title, URL, and tool-argument storage. Import idempotently and merge overlaps in the existing report. Use interaction evidence to infer attended work sessions, including work between questions; do not reduce the measure to generation time. Long unknown gaps remain reviewable, not zero and not automatically billed.

## Acceptance checks for a future implementation

1. Human interaction produces one receipt with the intended project and no content.
2. An autonomous wakeup and a child-agent run do not add human working hours.
3. Replaying the same event or report does not add time or duplicate evidence.
4. Concurrent Pi, local Codex, and Dot work counts once within the same measure.
5. Missing start/end, a long gap, disconnect, and hook delivery failure remain explicit.
6. Midnight/timezone boundaries are handled consistently; projectless cloud sessions are not silently attributed to CoralBricks.
7. Reading history neither sends a message, marks a room read, creates a room, nor changes task state.

These checks are proposed, not run. Existing tracker tests were inspected, not rerun; no implementation was changed.

## Sources

- https://learn.chatgpt.com/docs/dots
- https://learn.chatgpt.com/docs/dots/tasks-and-memory
- https://learn.chatgpt.com/docs/hooks
- https://learn.chatgpt.com/docs/enterprise/cloud-local-access
- https://learn.chatgpt.com/docs/enterprise/workspace-analytics
- https://learn.chatgpt.com/docs/enterprise/compliance-api
- https://developers.openai.com/api/docs/guides/agents-api/tracing

## Compiler proposal

Reusable lesson for the shared work-time-tracking playbook: establish the actual local/cloud execution boundary, storage freshness, event origin and hook coverage before adopting a new client as a time source. A desktop app may contain current cloud-profile metadata while its local conversation database is stale. Latest-activity caches and agent runtimes are not human work-session histories.

That owner is outside this CoralBricks workspace. Proposed only; no shared skill or policy was changed.
