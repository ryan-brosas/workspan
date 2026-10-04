# Workspan Claude Code hook

Claude Code runs `hook.ts` with a JSON payload on stdin for the events it is
configured for. The mapping is stateless, because each invocation is its own process:

| Hook | Evidence |
| --- | --- |
| `UserPromptSubmit` | `agent-start` (automated), plus `interaction` presence of **unknown** origin |
| `Stop` / `SubagentStop` | `agent-end` |
| `SessionEnd` | `agent-end` |

An end without a start contributes nothing, so a restart or a replayed hook is
harmless. The hook writes nothing to stdout (Claude Code reads it for some events),
records no prompt text, and exits 0 even when the daemon is down: the evidence stays
in the spool for the next hook to deliver.

## Install

`~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "bun /mnt/ssd/work/project/workspan/adapters/claude/hook.ts" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "bun /mnt/ssd/work/project/workspan/adapters/claude/hook.ts" }] }],
    "SubagentStop": [{ "hooks": [{ "type": "command", "command": "bun /mnt/ssd/work/project/workspan/adapters/claude/hook.ts" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "bun /mnt/ssd/work/project/workspan/adapters/claude/hook.ts" }] }]
  }
}
```

Installed on 2026-10-04. Verify with `bun test test/harness-hooks.test.ts` (the
mapping and a real round trip through the socket) and, after a Claude session,
`workspan status | jq '.coverage.sources'`.
