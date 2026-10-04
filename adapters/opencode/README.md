# Workspan opencode plugin

Maps opencode's session lifecycle to Workspan evidence. A run opens with the first
tool call or chat message in a session and closes when the session settles
(`session.idle`) or is deleted, so the agent measure is one interval per run rather
than a stream of tool calls. A chat message is presence of **unknown** origin: a
queued or scripted prompt looks the same as a typed one.

No prompt text, tool arguments or model output leave the process - only the event
name, the session id and the working directory, through `src/client.ts` and the spool
it owns.

## Install

In `~/.config/opencode/opencode.json`:

```json
"plugin": ["/mnt/ssd/work/project/workspan/adapters/opencode/index.ts"]
```

Installed on 2026-10-04. The plugin list is read when opencode's shared app-server
starts, so a run in a server that predates the change emits nothing: restart the
opencode app-server (or wait for it to exit) before expecting evidence.
`bun test test/harness-hooks.test.ts` covers the mapping itself, including that an
idle with no open run and an unmapped event produce nothing.

## Verify

```sh
workspan status | jq '.coverage.sources'          # an `opencode` source appears
workspan status | jq '.coverage.open_agent_turns' # 0 after the settle event paired the run
```
