import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunTracker, directoryOf, sessionOf } from "../adapters/opencode/index.ts";
import { observationsForHook } from "../adapters/claude/hook.ts";
import { evidenceFor } from "../adapters/evidence.ts";
import { WorkspanClient } from "../src/client.ts";
import { WorkspanStore } from "../src/daemon/db.ts";
import { startDaemon, type Daemon } from "../src/daemon/server.ts";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const t0 = 1_700_000_000_000;

test("opencode: a run opens once and settles on idle, so runtime is one interval", () => {
  const tracker = new RunTracker();
  expect(tracker.toolCall("ses_1", t0)).toEqual([{ what: "run", kind: "agent-start", origin: "automated", session: "ses_1", at: t0 }]);
  // A second tool call inside the same run adds nothing: the run is the interval.
  expect(tracker.toolCall("ses_1", t0 + 1_000)).toEqual([]);
  expect(tracker.settle({ type: "session.idle", properties: { sessionID: "ses_1" } }, t0 + 60_000))
    .toMatchObject({ what: "idle", kind: "agent-end", origin: "automated", session: "ses_1" });
  expect(tracker.openRuns).toBe(0);
  // An idle with no open run, and anything that is not a settle signal, are nothing.
  expect(tracker.settle({ type: "session.idle", properties: { sessionID: "ses_1" } }, t0 + 61_000)).toBeNull();
  expect(tracker.settle({ type: "message.updated", properties: { sessionID: "ses_1" } }, t0 + 62_000)).toBeNull();
  // A queued prompt is presence of unknown origin, never attendance.
  const message = tracker.message("ses_2", t0 + 70_000);
  expect(message.map(observation => observation.kind)).toEqual(["agent-start", "interaction"]);
  expect(message[1].origin).toBe("unknown");
  // Deleting a session closes its run instead of leaving it open forever.
  expect(tracker.settle({ type: "session.deleted", properties: { sessionID: "ses_2" } }, t0 + 80_000))
    .toMatchObject({ what: "deleted", kind: "agent-end" });
});

test("opencode: the session and directory are read from whichever shape the event uses", () => {
  expect(sessionOf({ sessionID: "a" })).toBe("a");
  expect(sessionOf({ info: { sessionID: "b" } })).toBe("b");
  expect(sessionOf({ session: { id: "c" } })).toBe("c");
  expect(sessionOf({})).toBeNull();
  expect(directoryOf({ directory: "/x" })).toBe("/x");
  expect(directoryOf({ info: { cwd: "/y" } })).toBe("/y");
  expect(directoryOf({})).toBeUndefined();
});

test("claude: a prompt opens a run and a stop closes it, with the cwd as the root", () => {
  const prompt = observationsForHook({ hook_event_name: "UserPromptSubmit", session_id: "claude-1", cwd: "/repo" }, t0);
  expect(prompt.map(observation => [observation.what, observation.kind, observation.origin]))
    .toEqual([["run", "agent-start", "automated"], ["prompt", "interaction", "unknown"]]);
  expect(prompt[0].root).toBe("/repo");
  expect(observationsForHook({ hook_event_name: "Stop", session_id: "claude-1" }, t0 + 5_000).map(observation => [observation.what, observation.kind]))
    .toEqual([["stop", "agent-end"]]);
  expect(observationsForHook({ hook_event_name: "SessionEnd", session_id: "claude-1" }, t0 + 9_000).map(observation => observation.what)).toEqual(["end"]);
  // Nothing to attach to, or an event this adapter does not map: no evidence, no guess.
  expect(observationsForHook({ hook_event_name: "Stop" }, t0)).toEqual([]);
  expect(observationsForHook({ hook_event_name: "PreToolUse", session_id: "claude-1" }, t0)).toEqual([]);
  expect(observationsForHook(null, t0)).toEqual([]);
});

test("the two observations of one prompt are two identities, never a conflict", () => {
  const [run, presence] = observationsForHook({ hook_event_name: "UserPromptSubmit", session_id: "s" }, t0);
  const opened = evidenceFor("claude", run);
  const annotation = evidenceFor("claude", presence);
  expect(opened.event).not.toBe(annotation.event);
  expect(opened.kind).not.toBe(annotation.kind);
});

test("the Claude hook script delivers through the real socket and stays silent", async () => {
  const root = mkdtempSync(join(tmpdir(), "workspan-hook-"));
  roots.push(root);
  const runtimeDir = join(root, "run");
  const store = new WorkspanStore(join(root, "workspan.sqlite"));
  const daemon: Daemon = await startDaemon({ store, runtimeDir, idleGapMs: 900_000 });
  try {
    const hookPath = join(import.meta.dir, "../adapters/claude/hook.ts");
    for (const payload of [
      { hook_event_name: "UserPromptSubmit", session_id: "claude-1", cwd: "/repo" },
      { hook_event_name: "Stop", session_id: "claude-1" },
    ]) {
      const proc = Bun.spawn([process.execPath, hookPath], {
        stdin: "pipe", stdout: "pipe", stderr: "pipe",
        env: { ...process.env, WORKSPAN_RUNTIME_DIR: runtimeDir },
      });
      proc.stdin.write(JSON.stringify(payload));
      proc.stdin.end();
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      expect(await proc.exited).toBe(0);
      expect(stdout).toBe("");
      expect(stderr).toBe("");
    }
    const client = new WorkspanClient({ socketPath: join(runtimeDir, "workspan.sock") });
    const status = await client.status() as { coverage: { sources: Array<{ source: string; events: number }>; open_agent_turns: number } };
    expect(status.coverage.sources.find(source => source.source === "claude")?.events).toBe(3);
    // The stop paired the run: nothing is left open, so the agent measure is closed.
    expect(status.coverage.open_agent_turns).toBe(0);
    // The root travelled, and the daemon left it unattributed rather than guessing.
    const day = await client.day() as { text: string };
    expect(day.text).toContain("Agent runtime");
  } finally { await daemon.close(); store.close(); }
});
