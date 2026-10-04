# The local protocol

The daemon serves one Unix socket. Everything else - the CLI, `workspan mcp`, the
harness adapters and the Omarchy widget's CLI calls - is a client of it. This file is
the contract those clients are written against; `src/client.ts` is the reference
implementation, and a client that uses it cannot drift from what is written here.

## Transport

| Item | Value |
| --- | --- |
| Socket | `$XDG_RUNTIME_DIR/workspan/workspan.sock` (override: `WORKSPAN_RUNTIME_DIR`), mode `0600` in a `0700` directory |
| Framing | one UTF-8 JSON object per line (`\n`), at most 64 KiB per frame |
| Request | `{ "v": 1, "id": "<caller-chosen>", "method": "<name>", "params": { … } }` |
| Success | `{ "id": "<same>", "ok": true, "result": { … } }` |
| Failure | `{ "id": "<same>", "ok": false, "error": { "code": "snake_case", "message": "bounded, content-free" } }` |

One request per connection is enough and is what the CLI does; the daemon reads a
line, answers, and keeps the connection open until the client closes it. A frame over
the limit is refused before parsing. `id` is echoed and otherwise ignored.

## Versioning

`v` is the protocol version, currently **1**. A frame whose `v` is not 1 is refused
with `unsupported_protocol_version`; an unknown method is refused with
`unknown_method`. Within a version the surface only **grows**: new methods, new
optional params and new result fields. A change that would break an existing client
bumps `v`. `health` reports the version the daemon speaks, so a client can check
before it depends on a newer field.

## Methods

| Method | Params | Result (abridged) | Notable error codes |
| --- | --- | --- | --- |
| `health` | - | `state`, `schema`, `protocol`, `socket`, `status_file`, `database` | - |
| `status` | - | the materialized status (see below) | - |
| `day` | `date?`, `timezone?` | `{ date, timezone, text }` | `bad_request` for an impossible day |
| `projects` | - | `{ bindings: [{ root, project, explicit, source }] }` | - |
| `projects.bind` | `root`, `project`, `explicit?` | `{ bindings }` | `bad_request` |
| `ingest` | `events: [...]` | `{ accepted, duplicates, conflicts, receipts, batches? }` | `bad_request`, `too_many_events` |
| `engine` | - | the accounting engine identity and a live probe | - |
| `session.start` | `project?`, `root?`, `at?` | `{ receipt, session, key, project, root, started_at, corrected? }` | `session_open`, `bad_request` |
| `session.stop` | `session?`, `note?`, `at?` | `{ receipt, session, key, stopped_at, note?, corrected? }` | `no_open_session`, `no_such_session`, `session_removed`, `bad_request` |
| `session.pause` / `session.resume` | `at?` | `{ receipt, session, state, unchanged? }` | `no_open_session`, `bad_request` |
| `session.toggle` | `project?`, `root?` | `{ receipt, action, session }` | `bad_request` |
| `session.switch` | `project?`, `root?` | `{ receipts, closed, session, project, root }` | `bad_request` |
| `session.note` | `note`, `session?`, `idle?` | `{ note, session, project, idle? }` | `no_open_session`, `no_such_session`, `session_removed`, `no_idle_stretch`, `no_covering_session`, `bad_request` |
| `session.remove` | `session`, `reason` | `{ removed, session, project, reason, alreadyRemoved? }` | `no_such_session`, `session_open`, `bad_request` |
| `session.list` | - | `{ sessions: [...] }` | - |

`session` values in results are what the caller passes back to the other session
methods; `key` is the internal identity, for diagnostics only.

## The status object

`schema`, `generated_at`, `idle_gap_ms`, `engine`, `measures`, `current_session`,
`last_idle`, `uncovered`, `coverage`, `watermark`, `non_additive`.

The laws the numbers obey are not negotiable in a client:

- **Three measures, never one total.** `measures.attested`, `measures.inferred` and
  `measures.agent` are separate; nothing may add them together. `non_additive` says
  so out loud.
- **Every total comes from Bend** through `src/core`. `union_ms` is a generated-policy
  union; a client must not sum intervals itself.
- **Evidence is at-least-once and idempotent.** An event's identity is
  `source + instance + session + event`; the same identity with the same metadata is a
  duplicate, and the same identity with different metadata is a **conflict** the report
  shows rather than a silent overwrite.
- **Presence never counts.** Desktop and harness annotations arrive with
  `origin: "unknown"` and change no measure; only the person's own commands attest.
- **Notes are the person's.** `session.note` takes one line, at most 200 characters,
  append-only; no client writes a note the person did not dictate.
- **Corrections are stated moments, never edits.** `at` is integer epoch
  milliseconds, never in the future, and the report marks a session whose boundaries
  were recorded later. Nothing is rewritten.

## Evidence events

An event is validated against an allowlist; unknown fields are refused, not ignored.

```json
{ "v": 1, "source": "pi", "instance": "laptop", "session": "<source session>",
  "event": "<stable source event id>", "kind": "interaction", "at": 1791114896765,
  "origin": "human", "root": "/home/you/src/project" }
```

`source` names a namespace (`pi`, `codex`, `opencode`, `claude`, `desktop`, `manual`),
never a vendor payload. `root` is the workspace the evidence happened in, derived
mechanically; **the daemon resolves attribution from bindings**, so an adapter never
names a client. Adapters write their evidence to a spool first
(`EvidenceSpool`) and flush it here, which is why a stopped daemon loses nothing.

## What a harness adapter should do

1. Use `src/client.ts` for transport and spooling; do not hand-roll framing.
2. Emit only coarse metadata: `{ root, session, at, kind, origin }`. No prompts, no
   tool payloads, no titles, no client names.
3. Subscribe to the harness's own lifecycle: session start, turn start, and the
   *settled* end of an agent run (not merely "the model finished"), then emit
   `interaction` (human presence) or `agent-start` / `agent-end` (runtime).
4. Never start or stop a session because an agent ran. Attestation is the person's.

`workspan mcp` exposes the same daemon over MCP stdio as agent-facing tools
(`work_status`, `work_day`, `work_sessions`, `work_projects`, `work_note`,
`work_session`); it is a thin proxy with no state of its own.
