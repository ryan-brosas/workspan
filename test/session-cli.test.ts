import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspanStore } from "../src/daemon/db.ts";
import { startDaemon, type Daemon } from "../src/daemon/server.ts";
import { validateEvent } from "../src/daemon/evidence.ts";

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

test("the draft paths: previous-session notes, leading-dash words, one line only", async () => {
  const root = mkdtempSync(join(tmpdir(), "workspan-draft-edges-"));
  const runtimeDir = join(root, "run");
  const store = new WorkspanStore(join(root, "workspan.sqlite"));
  const local = await startDaemon({ store, runtimeDir, idleGapMs: 900_000 });
  const send = async (...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/workspan.ts"), "--socket", join(runtimeDir, "workspan.sock"), ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, stdout, stderr };
  };
  try {
    // --explicit is a boolean and must not consume the following root.
    const binding = await send("projects", "bind", "--explicit", root, "literal-notes");
    expect(binding.code).toBe(0);
    const bindings = JSON.parse((await send("projects", "--json")).stdout) as Array<{ root: string; explicit: boolean }>;
    expect(bindings.find(row => row.root === root)?.explicit).toBe(true);
    const started = JSON.parse((await send("session", "start")).stdout) as { session: string };
    // Plain stop stores no note.
    expect((await send("session", "stop", "--session", started.session)).code).toBe(0);
    // The widget's Save note after a stop: the draft still files to that session.
    expect((await send("note", "drafted while it ran", "--session", started.session)).code).toBe(0);
    // A note is not a flag: leading dashes stay the words of the person.
    expect((await send("note", "--debugged the parser", "--session", started.session)).code).toBe(0);
    // Literal notes must never become targeting, socket or idle flags.
    const literalNotes = ["--session", "--socket", "--idle", "--at", "--", "note"];
    for (const note of literalNotes) {
      expect((await send("note", "--session", started.session, "--", note)).code).toBe(0);
    }
    // A note stays a single line, as the daemon requires.
    expect((await send("note", "two\nlines", "--session", started.session)).code).not.toBe(0);
    const facts = JSON.parse((await send("day", "--json")).stdout) as { days: Array<{ sessions: Array<{ session: string; notes: string[]; ended_at: number | null }> }> };
    const row = facts.days.flatMap(day => day.sessions).find(session => session.notes.includes("drafted while it ran"));
    expect(row).toBeDefined();
    expect(row!.ended_at).not.toBeNull();
    expect(row!.notes).toContain("--debugged the parser");
    for (const note of literalNotes) expect(row!.notes).toContain(note);
    expect(row!.notes.some(note => note.includes("two\nlines"))).toBe(false);

    // Literal notes and option values that look like flags must never retarget a
    // note: the session named explicitly decides, not whatever is open. The
    // stopped session from above is the explicit target while a fresh session B
    // is open, so a fallback to the open session would file the note wrong.
    for (const note of ["--reason", "--id", "--session", "--"]) {
      const next = JSON.parse((await send("session", "start")).stdout) as { session: string };
      expect((await send("note", "--session", started.session, "--", note)).code).toBe(0);
      const day = JSON.parse((await send("day", "--json")).stdout) as typeof facts;
      const target = day.days.flatMap(day => day.sessions).find(session => session.session === started.session);
      const open = day.days.flatMap(day => day.sessions).find(session => session.session === next.session);
      expect(target!.notes).toContain(note);
      expect(open!.notes).not.toContain(note);
      expect((await send("session", "stop", "--session", next.session)).code).toBe(0);
    }

    // A stop value that is literally "--" stays that value; the real --session
    // after it is still parsed, and the note is exactly the delimiter.
    const delimiter = JSON.parse((await send("session", "start")).stdout) as { session: string };
    expect((await send("session", "stop", "--note", "--", "--session", delimiter.session)).code).toBe(0);
    const afterDelimiter = JSON.parse((await send("day", "--json")).stdout) as typeof facts;
    const delimiterRow = afterDelimiter.days.flatMap(day => day.sessions).find(session => session.session === delimiter.session);
    expect(delimiterRow!.notes).toEqual(["--"]);
    expect(delimiterRow!.ended_at).not.toBeNull();

    // The note group is the positional command, not the first literal "note" in
    // the line: an option value of "note" must not move where the words start.
    const named = JSON.parse((await send("session", "start")).stdout) as { session: string };
    expect((await send("--project", "note", "note", "--session", named.session, "--", "kept")).code).toBe(0);
    const afterShift = JSON.parse((await send("day", "--json")).stdout) as typeof facts;
    const shifted = afterShift.days.flatMap(day => day.sessions).find(session => session.session === named.session);
    expect(shifted!.notes).toEqual(["kept"]);
    expect((await send("session", "stop", "--session", named.session)).code).toBe(0);
  } finally {
    await local.close(); store.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("a consumed flag value never becomes a note option or the text delimiter", async () => {
  const root = mkdtempSync(join(tmpdir(), "workspan-consumed-values-"));
  const runtimeDir = join(root, "run");
  const store = new WorkspanStore(join(root, "workspan.sqlite"));
  // A closed attested session covering the latest seat-idle stretch, plus a
  // different session that stays open: two distinct targets a misread argv could
  // pick between, so a wrong pick is visible in the stored note's owner.
  const base = Date.now() - 3_600_000;
  const at = (kind: string, offset: number): void => {
    store.ingest(validateEvent({ v: 1, source: "manual", instance: "consumed-values", session: "idle-covered", event: kind, kind, at: base + offset, origin: "attested" }), base + offset);
  };
  at("session-start", 0);
  at("session-stop", 1_800_000);
  for (const [kind, offset] of [["idle", 600_000], ["resumed", 900_000]] as const) {
    store.ingest(validateEvent({ v: 1, source: "desktop", instance: "consumed-values", session: "desktop", event: `${kind}:${base + offset}:300000`, kind: "interaction", at: base + offset, origin: "unknown" }), base + offset);
  }
  const local = await startDaemon({ store, runtimeDir, idleGapMs: 900_000 });
  const send = async (...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/workspan.ts"), "--socket", join(runtimeDir, "workspan.sock"), ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, stdout, stderr };
  };
  try {
    const open = JSON.parse((await send("session", "start")).stdout) as { session: string };

    // "--idle" is consumed as the value of "--project", so it is a value, not the
    // idle flag. The note must go to the explicit open session, not the closed
    // session that covers the idle stretch, and no idle block may be reported.
    const idleValue = await send("--project", "--idle", "note", "--session", open.session, "--", "consumed-idle");
    expect(idleValue.code).toBe(0);
    const idleNote = JSON.parse(idleValue.stdout) as { session: string; idle?: unknown; note: { text: string } };
    expect(idleNote.session).toBe(open.session);
    expect(idleNote.idle).toBeUndefined();
    expect(idleNote.note.text).toBe("consumed-idle");

    // The first "--" is consumed as the value of "--project", so it is not the
    // delimiter. Only the final unconsumed "--" starts the person's free text.
    const delimiterValue = await send("note", "--project", "--", "--session", open.session, "--", "delimiter-text");
    expect(delimiterValue.code).toBe(0);
    const delimiterNote = JSON.parse(delimiterValue.stdout) as { session: string; note: { text: string } };
    expect(delimiterNote.session).toBe(open.session);
    expect(delimiterNote.note.text).toBe("delimiter-text");

    // Exact ownership: both notes are on the open session and neither leaked.
    const facts = JSON.parse((await send("day", "--json")).stdout) as { days: Array<{ sessions: Array<{ session: string; notes: string[] }> }> };
    const rows = facts.days.flatMap(day => day.sessions);
    expect(rows.find(row => row.session === open.session)!.notes).toEqual(["consumed-idle", "delimiter-text"]);
    expect(rows.find(row => row.session === "idle-covered")!.notes).toEqual([]);
  } finally {
    await local.close(); store.close(); rmSync(root, { recursive: true, force: true });
  }
});
