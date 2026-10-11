import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspanStore } from "../src/daemon/db.ts";
import { startDaemon, type Daemon } from "../src/daemon/server.ts";
import { validateEvent } from "../src/daemon/evidence.ts";

interface CliResult { code: number; stdout: string; stderr: string; args: string[] }

/** Exactly the argv the bar widget builds: [cliPath, "--socket", socketPath, ...].
 *  One helper parameterized by socket directory, so the spawn plumbing lives in
 *  one place instead of being copied per test. */
function cliAt(dir: string) {
  return async (...args: string[]): Promise<CliResult> => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/workspan.ts"), "--socket", join(dir, "workspan.sock"), ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, stdout, stderr, args };
  };
}

/** Parse JSON only after a clean exit: a refusal then surfaces the CLI's stderr
 *  instead of failing as an opaque JSON parse error. */
async function json<T>(result: Promise<CliResult>): Promise<T> {
  const { code, stdout, stderr, args } = await result;
  if (code !== 0) throw new Error(`workspan ${JSON.stringify(args)} exited with ${code}: ${stderr.trim() || stdout.trim()}`);
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`workspan ${JSON.stringify(args)} exited 0 with non-JSON stdout: ${stdout.trim() || "(empty)"}${stderr.trim() ? ` (stderr: ${stderr.trim()})` : ""}`);
  }
}

const root = mkdtempSync(join(tmpdir(), "workspan-session-cli-"));
const runtimeDir = join(root, "run");
const store = new WorkspanStore(join(root, "workspan.sqlite"));
const cli = cliAt(runtimeDir);
let daemon: Daemon | null = null;

afterAll(async () => { if (daemon) await daemon.close(); store.close(); rmSync(root, { recursive: true, force: true }); });

test("the widget's clock in and out commands drive one attested session end to end", async () => {
  // Pin the daemon clock and report day: the commands here span many process
  // spawns, and a run straddling local midnight would otherwise file the
  // sessions into the previous day and make the report lookups intermittent.
  const base = Date.UTC(2026, 9, 10, 11);
  let clock = base;
  daemon = await startDaemon({ store, runtimeDir, idleGapMs: 900_000, now: () => clock++ });

  // Clock in.
  const started = await json<{ session: string }>(cli("session", "start"));
  expect(typeof started.session).toBe("string");

  // The widget offers Clock in only when nothing is open; the daemon must refuse a
  // second session rather than silently opening a parallel one.
  const second = await cli("session", "start");
  expect(second.code).not.toBe(0);
  expect(second.stderr).toContain("session_open");

  expect((await json<{ current_session: { session: string } }>(cli("status"))).current_session.session).toBe(started.session);

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
  expect((await json<{ current_session: unknown }>(cli("status"))).current_session).toBeNull();

  // The evidence survives clocking out, and the day report can speak for it.
  const facts = await json<{ days: Array<{ sessions: Array<{ notes: string[]; ended_at: number | null }> }> }>(cli("day", "--date", "2026-10-10", "--tz", "UTC", "--json"));
  const session = facts.days.flatMap(d => d.sessions).find(row => row.notes.includes("reviewed the auth flow"));
  expect(session).toBeDefined();
  expect(session!.ended_at).not.toBeNull();
  // Both activities are the person's own words, kept in order.
  expect(session!.notes).toContain("paired with the agent");
});

test("the draft paths: previous-session notes, leading-dash words, one line only", async () => {
  const root = mkdtempSync(join(tmpdir(), "workspan-draft-edges-"));
  const runtimeDir = join(root, "run");
  const store = new WorkspanStore(join(root, "workspan.sqlite"));
  const send = cliAt(runtimeDir);
  let local: Daemon | null = null;
  try {
    local = await startDaemon({ store, runtimeDir, idleGapMs: 900_000 });
    // --explicit is a boolean and must not consume the following root.
    const binding = await send("projects", "bind", "--explicit", root, "literal-notes");
    expect(binding.code).toBe(0);
    const bindings = await json<Array<{ root: string; explicit: boolean }>>(send("projects", "--json"));
    expect(bindings.find(row => row.root === root)?.explicit).toBe(true);
    const started = await json<{ session: string }>(send("session", "start"));
    // Plain stop stores no note: read the report back rather than trusting the
    // later self-referential expectedNotes seed.
    expect((await send("session", "stop", "--session", started.session)).code).toBe(0);
    const afterPlainStop = await json<{ days: Array<{ sessions: Array<{ session: string; notes: string[] }> }> }>(send("day", "--json"));
    expect(afterPlainStop.days.flatMap(d => d.sessions).find(session => session.session === started.session)!.notes).toEqual([]);
    // The widget's Save note after a stop: the draft still files to that session.
    expect((await send("note", "drafted while it ran", "--session", started.session)).code).toBe(0);
    // A note is not a flag: leading dashes stay the words of the person.
    expect((await send("note", "--debugged the parser", "--session", started.session)).code).toBe(0);
    // Literal notes must never become targeting, socket or idle flags.
    const literalNotes = ["--session", "--socket", "--idle", "--at", "--", "note", "--json", "--explicit"];
    for (const note of literalNotes) {
      expect((await send("note", "--session", started.session, "--", note)).code).toBe(0);
    }
    // A note stays a single line, as the daemon requires.
    expect((await send("note", "two\nlines", "--session", started.session)).code).not.toBe(0);
    const facts = await json<{ days: Array<{ sessions: Array<{ session: string; notes: string[]; ended_at: number | null }> }> }>(send("day", "--json"));
    const row = facts.days.flatMap(d => d.sessions).find(session => session.notes.includes("drafted while it ran"));
    expect(row).toBeDefined();
    expect(row!.ended_at).not.toBeNull();
    expect(row!.notes).toContain("--debugged the parser");
    for (const note of literalNotes) expect(row!.notes).toContain(note);
    expect(row!.notes.some(note => note.includes("two\nlines"))).toBe(false);

    // Literal notes and option values that look like flags must never retarget a
    // note: the session named explicitly decides, not whatever is open. The
    // stopped session from above is the explicit target while a fresh session B
    // is open, so a fallback to the open session would file the note wrong.
    const expectedNotes = [...row!.notes];
    for (const note of ["--reason", "--id", "--session", "--"]) {
      const next = await json<{ session: string }>(send("session", "start"));
      expect((await send("note", "--session", started.session, "--", note)).code).toBe(0);
      const day = await json<typeof facts>(send("day", "--json"));
      const target = day.days.flatMap(d => d.sessions).find(session => session.session === started.session);
      const open = day.days.flatMap(d => d.sessions).find(session => session.session === next.session);
      expectedNotes.push(note);
      expect(target!.notes).toEqual(expectedNotes);
      expect(open!.notes).not.toContain(note);
      expect((await send("session", "stop", "--session", next.session)).code).toBe(0);
    }

    // A stop value that is literally "--" stays that value; the real --session
    // after it is still parsed, and the note is exactly the delimiter.
    const delimiter = await json<{ session: string }>(send("session", "start"));
    expect((await send("session", "stop", "--note", "--", "--session", delimiter.session)).code).toBe(0);
    const afterDelimiter = await json<typeof facts>(send("day", "--json"));
    const delimiterRow = afterDelimiter.days.flatMap(d => d.sessions).find(session => session.session === delimiter.session);
    expect(delimiterRow!.notes).toEqual(["--"]);
    expect(delimiterRow!.ended_at).not.toBeNull();

    // The note group is the positional command, not the first literal "note" in
    // the line: an option value of "note" must not move where the words start.
    const named = await json<{ session: string }>(send("session", "start"));
    expect((await send("--project", "note", "note", "--session", named.session, "--", "kept")).code).toBe(0);
    const afterShift = await json<typeof facts>(send("day", "--json"));
    const shifted = afterShift.days.flatMap(d => d.sessions).find(session => session.session === named.session);
    expect(shifted!.notes).toEqual(["kept"]);

    // Refuse ambiguity and malformed options before either adding a note or stopping.
    for (const [argv, message] of [
      [["note", "--session", named.session, "fixed", "--session", "bug"], "only once"],
      [["note", "--socket", "ignored", "fixed"], "only once"],
      [["note", "fixed", "--at"], "put it after --"],
      [["note", "--json", "hello"], "does not take --json"],
      [["note", "--check"], "does not take --check"],
      [["--debugged", "note", "fixed"], "unknown option"],
      [["day", "-json"], "unknown option"],
      [["session", "stop", "--note", "one", "--", "two"], "not both"],
      [["session", "stop", "forgot", "delimiter"], "put closing-note text after --"],
      [["session", "stop", "--note", "one", "--note", "two"], "only once"],
    ] as const) {
      const refused = await send(...argv);
      expect(refused.code, JSON.stringify(argv)).not.toBe(0);
      expect(refused.stderr, JSON.stringify(argv)).toContain(message);
    }
    expect((await json<{ current_session: { session: string } }>(send("status"))).current_session.session).toBe(named.session);

    // Pause/resume compare against the displayed session atomically in the daemon.
    for (const action of ["pause", "resume"]) {
      const refused = await send("session", action, "--session", started.session);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("session_changed");
      expect((await json<{ current_session: { state: string } }>(send("status"))).current_session.state).toBe("running");
    }
    expect((await send("session", "pause", "--session", named.session)).code).toBe(0);
    const wrongResume = await send("session", "resume", "--session", started.session);
    expect(wrongResume.stderr).toContain("session_changed");
    expect((await json<{ current_session: { state: string } }>(send("status"))).current_session.state).toBe("paused");
    expect((await send("session", "resume", "--session", named.session)).code).toBe(0);

    // A stop's free text after the real delimiter is its closing note, never
    // silently dropped: the delimiter protects literal text for stop too.
    expect((await send("session", "stop", "--session", named.session, "--", "fixed the parser")).code).toBe(0);
    const afterStop = await json<typeof facts>(send("day", "--json"));
    const stopped = afterStop.days.flatMap(d => d.sessions).find(session => session.session === named.session);
    expect(stopped!.notes).toEqual(["kept", "fixed the parser"]);

    // A value-taking option with no value errors instead of silently becoming a
    // boolean that stops whatever happens to be open.
    const dangling = await send("session", "stop", "--session");
    expect(dangling.code).not.toBe(0);
    expect(dangling.stderr).toContain("requires a value");
    for (const option of ["--date", "--tz", "--socket"]) {
      const missing = await send("day", option);
      expect(missing.code).not.toBe(0);
      expect(missing.stderr).toContain(`option ${option} requires a value`);
    }

    // A recognized-looking typo is refused, not accepted as a boolean and dropped.
    const unknown = await send("status", "--require-clen");
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toContain("unknown option");

    // A recognized option this subcommand does not consume is refused, so the
    // person's words are never deleted from the note behind their back.
    const unsupported = await send("note", "shipped", "--at", "09:00");
    expect(unsupported.code).not.toBe(0);
    expect(unsupported.stderr).toContain("does not take --at");

    // --session and --idle are alternatives; both at once is ambiguous.
    const both = await send("note", "x", "--session", named.session, "--idle");
    expect(both.code).not.toBe(0);
    expect(both.stderr).toContain("not both");
  } finally {
    try { if (local) await local.close(); } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  }
});

test("a consumed flag value never becomes a note option or the text delimiter", async () => {
  const root = mkdtempSync(join(tmpdir(), "workspan-consumed-values-"));
  const runtimeDir = join(root, "run");
  const store = new WorkspanStore(join(root, "workspan.sqlite"));
  let local: Daemon | null = null;
  try {
    // Fixture setup is inside the protected region: a throw from the ingests,
    // the CLI helper or the daemon start must still close the store and remove
    // the temp dir. A closed attested session covering the latest seat-idle
    // stretch, plus a different session that stays open, gives a misread argv
    // two distinct targets, so a wrong pick is visible in the stored note's
    // owner. Pin both the daemon clock and report day: clamping to midnight
    // alone could put the fixture's stop/idle events into the future.
    const base = Date.UTC(2026, 9, 10, 11);
    let clock = base + 3_600_000;
    const at = (kind: string, offset: number): void => {
      store.ingest(validateEvent({ v: 1, source: "manual", instance: "consumed-values", session: "idle-covered", event: kind, kind, at: base + offset, origin: "attested" }), base + offset);
    };
    at("session-start", 0);
    at("session-stop", 1_800_000);
    for (const [kind, offset] of [["idle", 600_000], ["resumed", 900_000]] as const) {
      store.ingest(validateEvent({ v: 1, source: "desktop", instance: "consumed-values", session: "desktop", event: `${kind}:${base + offset}:300000`, kind: "interaction", at: base + offset, origin: "unknown" }), base + offset);
    }
    const send = cliAt(runtimeDir);
    local = await startDaemon({ store, runtimeDir, idleGapMs: 900_000, now: () => clock++ });
    const open = await json<{ session: string }>(send("session", "start"));

    // "--idle" is consumed as the value of "--project", so it is a value, not the
    // idle flag. The note must go to the explicit open session, not the closed
    // session that covers the idle stretch, and no idle block may be reported.
    const idleValue = await send("--project", "--idle", "note", "--session", open.session, "--", "consumed-idle");
    expect(idleValue.code).toBe(0);
    const idleNote = JSON.parse(idleValue.stdout) as { session: string; idle?: unknown; note: { text: string } };
    expect(idleNote.session).toBe(open.session);
    expect(idleNote.idle).toBeUndefined();
    expect(idleNote.note.text).toBe("consumed-idle");

    // The first "--" is a consumed project value, not the delimiter.
    // This does not depend on duplicate socket-option precedence.
    const delimiterValue = await send("--project", "--", "note", "--session", open.session, "--", "delimiter-text");
    expect(delimiterValue.code).toBe(0);
    const delimiterNote = JSON.parse(delimiterValue.stdout) as { session: string; note: { text: string } };
    expect(delimiterNote.session).toBe(open.session);
    expect(delimiterNote.note.text).toBe("delimiter-text");

    // Exact ownership: both notes are on the open session and neither leaked.
    const facts = await json<{ days: Array<{ sessions: Array<{ session: string; notes: string[] }> }> }>(send("day", "--date", "2026-10-10", "--tz", "UTC", "--json"));
    const rows = facts.days.flatMap(d => d.sessions);
    expect(rows.find(row => row.session === open.session)!.notes).toEqual(["consumed-idle", "delimiter-text"]);
    expect(rows.find(row => row.session === "idle-covered")!.notes).toEqual([]);
  } finally {
    try { if (local) await local.close(); } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  }
});

test("the packaged daemon argv reaches the daemon entry point and starts", async () => {
  const root = mkdtempSync(join(tmpdir(), "workspan-daemon-cli-"));
  const runtimeDir = join(root, "run");
  const spoolDir = join(root, "spool");
  const db = join(root, "workspan.sqlite");
  // The packaged unit starts `workspan daemon --foreground`; the daemon's own
  // entry point also owns --db, --runtime-dir, --spool-dir, the millisecond
  // flags and --no-harness. Testing startDaemon() directly cannot catch an
  // outer parser that rejects those flags, so spawn the real CLI and wait for
  // the entry point's own listening announcement.
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  let drainErr: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const decoderOut = new TextDecoder();
  const decoderErr = new TextDecoder();
  let stdout = "";
  let stderr = "";
  try {
    proc = Bun.spawn([
      process.execPath, join(import.meta.dir, "../src/cli/workspan.ts"),
      "daemon", "--foreground",
      "--db", db,
      "--runtime-dir", runtimeDir,
      "--spool-dir", spoolDir,
      "--idle-gap-ms", "900000",
      "--status-interval-ms", "60000",
      "--harness-window-ms", "604800000",
      "--no-harness",
    ], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const running = proc;
    drainErr = (async () => { for await (const chunk of running.stderr) stderr += decoderErr.decode(chunk, { stream: true }); })();
    const announced = await Promise.race([
      (async () => {
        for await (const chunk of running.stdout) {
          stdout += decoderOut.decode(chunk as Uint8Array, { stream: true });
          const newline = stdout.indexOf("\n");
          if (newline !== -1) return JSON.parse(stdout.slice(0, newline)) as { listening: string; status: string; database: string };
        }
        throw new Error(`daemon stdout ended before it announced listening: ${stderr || stdout}`);
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`daemon did not announce listening within 10s: ${stderr || stdout}`)), 10_000); }),
    ]);
    expect(announced.database).toBe(db);
    expect(announced.listening).toContain("workspan.sock");
    expect(announced.status).toContain("status.json");
    expect(existsSync(join(runtimeDir, "workspan.sock"))).toBe(true);
  } finally {
    clearTimeout(timer);
    try {
      if (proc) { proc.kill("SIGTERM"); await proc.exited; }
      await drainErr;
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
