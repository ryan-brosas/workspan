#!/usr/bin/env bun
/**
 * Workspan hook for Claude Code.
 *
 * Claude Code runs this with a JSON payload on stdin for the events it is configured
 * for (SessionStart, UserPromptSubmit, Stop, SubagentStop, SessionEnd). Each
 * invocation is a separate process, so the mapping is deliberately stateless: a
 * prompt opens a run and emits a presence annotation of unknown origin, and the stop
 * events close it. An end without a start contributes nothing, which is what makes a
 * replay after a restart harmless.
 *
 * The hook never writes to stdout (Claude Code reads it for some events), never blocks
 * the session on a delivery failure, and never records prompt text: only the event
 * name, the session id and the working directory travel.
 *
 * Install: see adapters/claude/README.md.
 */
import { evidenceFor, spoolFor, type Observation } from "../evidence.ts";

const SOURCE = "claude";

/** The observations one hook payload means. Pure, so the tests drive it directly. */
export function observationsForHook(payload: unknown, at: number): Observation[] {
  const record = (payload ?? {}) as Record<string, unknown>;
  const event = typeof record.hook_event_name === "string" ? record.hook_event_name : "";
  const session = typeof record.session_id === "string" && record.session_id ? record.session_id : "";
  if (!session) return [];
  const root = typeof record.cwd === "string" && record.cwd ? record.cwd : undefined;
  const base = { session, at, ...(root ? { root } : {}) };
  switch (event) {
    case "UserPromptSubmit":
      return [
        { ...base, what: "run", kind: "agent-start", origin: "automated" },
        // A submitted prompt may have been typed or queued; presence, not attendance.
        { ...base, what: "prompt", kind: "interaction", origin: "unknown" },
      ];
    case "Stop":
      return [{ ...base, what: "stop", kind: "agent-end", origin: "automated" }];
    case "SubagentStop":
      return [{ ...base, what: "subagent-stop", kind: "agent-end", origin: "automated" }];
    case "SessionEnd":
      return [{ ...base, what: "end", kind: "agent-end", origin: "automated" }];
    default:
      return [];
  }
}

/** Read the payload, spool it, try to deliver, and always exit 0. */
export async function runHook(argv: string[] = process.argv.slice(2)): Promise<number> {
  let payload: unknown = null;
  try {
    const text = await new Response(Bun.stdin.stream()).text();
    payload = JSON.parse(text);
  } catch { return 0; }
  const spool = spoolFor(SOURCE, argv[0]);
  let appended = false;
  for (const observation of observationsForHook(payload, Date.now())) appended = spool.append(evidenceFor(SOURCE, observation)) || appended;
  if (!appended) return 0;
  // Delivery is best effort: a failure leaves the evidence spooled for the next hook.
  await Promise.race([spool.flush().catch(() => 0), new Promise(resolve => setTimeout(resolve, 1_500))]);
  return 0;
}

if (import.meta.main) {
  runHook().then(code => process.exit(code)).catch(() => process.exit(0));
}
