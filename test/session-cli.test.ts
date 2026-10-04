import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspanStore } from "../src/daemon/db.ts";
import { startDaemon, type Daemon } from "../src/daemon/server.ts";

const root = mkdtempSync(join(tmpdir(), "workspan-session-cli-"));
const runtimeDir = join(root, "run");
const store = new WorkspanStore(join(root, "workspan.sqlite"));
let daemon: Daemon | null = null;

afterAll(async () => { if (daemon) await daemon.close(); store.close(); rmSync(root, { recursive: true, force: true }); });

/** Exactly the argv the bar widget builds: [cliPath, "--socket", socketPath, ...]. */
async function cli(...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/workspan.ts"), "--socket", join(runtimeDir, "workspan.sock"), ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr };
}

test("the widget's clock in and out commands drive one attested session end to end", async () => {
  daemon = await startDaemon({ store, runtimeDir, idleGapMs: 900_000 });

  // Clock in.
  const start = await cli("session", "start");
  expect(start.code).toBe(0);
  const started = JSON.parse(start.stdout) as { session: string };
  expect(typeof started.session).toBe("string");

  // The widget offers Clock in only when nothing is open; the daemon must refuse a
  // second session rather than silently opening a parallel one.
  const second = await cli("session", "start");
  expect(second.code).not.toBe(0);
  expect(second.stderr).toContain("session_open");

  expect((JSON.parse((await cli("status")).stdout) as { current_session: { session: string } }).current_session.session).toBe(started.session);

  // Pause and resume are the same popup row's secondary buttons.
  expect((await cli("session", "pause")).code).toBe(0);
  expect((await cli("session", "resume")).code).toBe(0);

  // The popup's Save note path: an activity attaches to the running session.
  expect((await cli("note", "paired with the agent")).code).toBe(0);
  // The field mirrors the daemon's own bound for the note.
  expect((await cli("note", "x".repeat(201))).code).not.toBe(0);

  // Clock out, with the note a person would attach.
  const stop = await cli("session", "stop", "--session", started.session, "--note", "reviewed the auth flow");
  expect(stop.code).toBe(0);
  expect((JSON.parse((await cli("status")).stdout) as { current_session: unknown }).current_session).toBeNull();

  // The evidence survives clocking out, and the day report can speak for it.
  const day = await cli("day", "--json");
  expect(day.code).toBe(0);
  const facts = JSON.parse(day.stdout) as { days: Array<{ sessions: Array<{ notes: string[]; ended_at: number | null }> }> };
  const session = facts.days.flatMap(day => day.sessions).find(row => row.notes.includes("reviewed the auth flow"));
  expect(session).toBeDefined();
  expect(session!.ended_at).not.toBeNull();
  // Both activities are the person's own words, kept in order.
  expect(session!.notes).toContain("paired with the agent");
});
