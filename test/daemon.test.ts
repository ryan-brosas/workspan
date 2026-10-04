import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspanStore } from "../src/daemon/db.ts";
import { readStatusFile, startDaemon, type Daemon } from "../src/daemon/server.ts";

const roots: string[] = [];
let daemon: Daemon | null = null;
let store: WorkspanStore | null = null;
let runtimeDir = "";
let fixtureFile = "";
const base = 1_700_000_000_000;

function setup() {
  if (daemon) return;
  const root = mkdtempSync(join(tmpdir(), "workspan-daemon-"));
  roots.push(root);
  runtimeDir = join(root, "run");
  fixtureFile = join(root, "events.jsonl");
  store = new WorkspanStore(join(root, "workspan.sqlite"));
  const events = [
    { v: 1, source: "pi", instance: "laptop", session: "s1", event: "e1", kind: "interaction", at: base, origin: "human", project: "coral" },
    { v: 1, source: "pi", instance: "laptop", session: "s1", event: "e2", kind: "interaction", at: base + 300_000, origin: "human", project: "coral" },
    { v: 1, source: "codex", instance: "local", session: "c1", event: "x1", kind: "interaction", at: base + 120_000, origin: "human", project: "coral" },
    { v: 1, source: "codex", instance: "local", session: "c1", event: "t1", kind: "agent-start", at: base + 600_000, origin: "automated", project: "coral" },
    { v: 1, source: "codex", instance: "local", session: "c1", event: "t2", kind: "agent-end", at: base + 3_600_000, origin: "automated", project: "coral" },
    { v: 1, source: "desktop", instance: "omarchy", session: "d1", event: "p1", kind: "interaction", at: base + 3_000_000, origin: "human" },
  ];
  writeFileSync(fixtureFile, events.map(e => JSON.stringify(e)).join("\n") + "\n");
}

/** The real CLI, in its own process, awaited so the in-process daemon can answer. */
async function cli(...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/workspan.ts"), "--socket", join(runtimeDir, "workspan.sock"), ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr };
}

test("the daemon accepts, replays and reports through the real CLI", async () => {
  setup();
  daemon = await startDaemon({ store: store!, runtimeDir, idleGapMs: 900_000 });

  const first = await cli("ingest", "--file", fixtureFile);
  expect(first.stderr).toBe("");
  expect(first.code).toBe(0);
  expect(JSON.parse(first.stdout)).toMatchObject({ accepted: 6, duplicates: 0, conflicts: 0 });

  // Replaying the same file must change nothing at all.
  const replay = await cli("ingest", "--file", fixtureFile);
  expect(JSON.parse(replay.stdout)).toMatchObject({ accepted: 0, duplicates: 6, conflicts: 0 });

  const status = JSON.parse((await cli("status")).stdout) as ReturnType<typeof readStatusFile>;

  // Within the inferred measure, Pi and Codex overlap and count once.
  expect(status.measures.inferred.union_ms).toBe(300_000);
  expect(status.measures.inferred.projects).toEqual([{ project: "coral", ms: 300_000 }]);

  // Agent runtime is a separate measure, never merged into attended work.
  expect(status.measures.agent.union_ms).toBe(3_000_000);
  expect(status.measures.inferred.union_ms + status.measures.agent.union_ms).toBe(3_300_000);
  expect(status.non_additive).toContain("never added together");
  expect(status).not.toHaveProperty("total_ms");

  // The bar and popup can say which engine did the arithmetic.
  expect(status.engine?.label).toBe("generated Bend policy");
  expect(status.engine?.native).toBe(false);
  expect(status.engine?.version).toBe("2.0.31");
  expect(status.engine?.digest).toMatch(/^[0-9a-f]{64}$/);
  expect(status.engine?.sources).toEqual(["audit.bend", "batch.bend", "engine.bend"]);

  // The desktop path: the status file the shell plugin watches.
  expect(readStatusFile(runtimeDir).measures.inferred.union_ms).toBe(status.measures.inferred.union_ms);
  expect(JSON.parse(readFileSync(join(runtimeDir, "status.json"), "utf8")).schema).toBe(1);
  expect(status.coverage.sources.map(s => s.source).sort()).toEqual(["codex", "desktop", "pi"]);
  // The projectless desktop evidence contributes no time, and is not guessed.
  expect(status.measures.inferred.unallocated_ms).toBe(0);
});

test("an attested session reports separately and stays provisional while open", async () => {
  setup();
  const started = JSON.parse((await cli("session", "start", "--project", "coral")).stdout) as { session: string };
  let status = JSON.parse((await cli("status")).stdout) as ReturnType<typeof readStatusFile>;
  expect(status.current_session?.project).toBe("coral");
  expect(status.measures.attested.union_ms).toBe(0);
  expect(status.coverage.open_sessions).toBe(1);
  expect(status.current_session?.provisional_ms).toBeGreaterThanOrEqual(0);

  // The status carries the value session.stop takes back, so the widget never
  // has to know the daemon's internal key format.
  expect(status.current_session?.session).toBe(started.session);
  await cli("session", "stop", "--session", status.current_session!.session);
  status = JSON.parse((await cli("status")).stdout) as ReturnType<typeof readStatusFile>;
  expect(status.coverage.open_sessions).toBe(0);
  expect(status.current_session).toBeNull();
  expect(status.measures.attested.union_ms).toBeGreaterThan(0);
});

test("a conflict is visible in the materialized status, not only in the receipt", async () => {
  setup();
  const conflictFile = join(roots[0], "conflict.jsonl");
  writeFileSync(conflictFile, JSON.stringify({ v: 1, source: "pi", instance: "laptop", session: "s1", event: "e1", kind: "interaction", at: base, origin: "human", project: "other-client" }) + "\n");
  const refused = await cli("ingest", "--file", conflictFile);
  expect(JSON.parse(refused.stdout)).toMatchObject({ accepted: 0, conflicts: 1 });
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("evidence_conflict");

  const status = JSON.parse((await cli("status")).stdout) as ReturnType<typeof readStatusFile>;
  expect(status.coverage.conflicts).toBe(1);
  expect(readStatusFile(runtimeDir).coverage.conflicts).toBe(1);
  // The stored hours keep their original client.
  expect(status.measures.inferred.projects).toEqual([{ project: "coral", ms: 300_000 }]);
});

test("the status file stays fresh while the daemon is alive", async () => {
  setup();
  // The heartbeat is what makes the file a liveness signal rather than a record
  // of the last time something happened.
  const onDisk = readStatusFile(runtimeDir).generated_at;
  expect(Date.now() - onDisk).toBeLessThan(30_000);
  await new Promise(resolve => setTimeout(resolve, 1_100));
  const again = readStatusFile(runtimeDir).generated_at;
  expect(again).toBeGreaterThanOrEqual(onDisk);
});

test("pause, resume and switch are idempotent and close segments cleanly", async () => {
  setup();
  // A toggle with nothing open starts; a second start is refused, not stacked.
  expect(JSON.parse((await cli("session", "toggle", "--project", "coral")).stdout)).toMatchObject({ action: "started" });
  const stacked = await cli("session", "start", "--project", "coral");
  expect(stacked.code).toBe(1);
  expect(stacked.stderr).toContain("session_open");
  const started = JSON.parse((await cli("status")).stdout) as { current_session: { session: string } };
  expect(JSON.parse((await cli("session", "pause")).stdout)).toMatchObject({ state: "paused" });
  expect(JSON.parse((await cli("session", "pause")).stdout)).toMatchObject({ unchanged: true });
  expect(JSON.parse((await cli("session", "resume")).stdout)).toMatchObject({ state: "running" });
  expect(JSON.parse((await cli("session", "resume")).stdout)).toMatchObject({ unchanged: true });

  const switched = JSON.parse((await cli("session", "switch", "--project", "other")).stdout) as { closed: string | null; project: string | null };
  expect(switched.closed).toBe(started.current_session.session);
  expect(switched.project).toBe("other");

  const open = JSON.parse((await cli("status")).stdout) as { current_session: { project: string; state: string } | null; coverage: { open_sessions: number } };
  expect(open.current_session).toMatchObject({ project: "other", state: "running" });
  expect(open.coverage.open_sessions).toBe(1);

  await cli("session", "stop");
  const after = JSON.parse((await cli("status")).stdout) as { coverage: { open_sessions: number }; measures: { attested: { union_ms: number; projects: Array<{ project: string }> } } };
  expect(after.coverage.open_sessions).toBe(0);
  expect(after.measures.attested.projects.map(p => p.project).sort()).toEqual(["coral", "other"]);
});

test("a root-derived session attributes from the binding, never from a hard-coded client", async () => {
  setup();
  const bound = "/mnt/ssd/work/project/workspan";
  const unbound = "/mnt/ssd/work/project/elsewhere";
  await cli("projects", "bind", bound, "workspan");
  const started = JSON.parse((await cli("session", "start", "--root", bound)).stdout) as { session: string; project: string | null; root: string | null };
  expect(started.project).toBe("workspan");
  expect(started.root).toBe(bound);
  let status = JSON.parse((await cli("status")).stdout) as { current_session: { project: string | null; root: string | null; provisional_ms: number } | null; measures: { attested: { union_ms: number; projects: Array<{ project: string; ms: number }> } } };
  expect(status.current_session).toMatchObject({ project: "workspan", root: bound });
  await cli("session", "stop", "--session", started.session);
  status = JSON.parse((await cli("status")).stdout) as typeof status;
  // Earlier tests in this file already closed attested sessions, so assert this
  // session's own contribution rather than the cumulative union.
  expect(status.measures.attested.projects.find(p => p.project === "workspan")?.ms).toBeGreaterThan(0);

  // An unbound root stays unallocated: a directory name is not a client.
  const open = JSON.parse((await cli("session", "start", "--root", unbound)).stdout) as { project: string | null };
  expect(open.project).toBeNull();
  await cli("session", "stop");
});

test("notes attach to the open session and survive stop through the CLI", async () => {
  setup();
  await cli("session", "start", "--project", "coral");
  await cli("note", "reviewed the provider auth");
  let status = JSON.parse((await cli("status")).stdout) as { current_session: { project: string } };
  expect(status.current_session?.project).toBe("coral");

  const stopped = await cli("session", "stop", "--note", "also patched the report");
  expect(stopped.code).toBe(0);
  expect(JSON.parse(stopped.stdout)).toMatchObject({ note: { text: "also patched the report" } });

  // A note with nothing running is a clear error, not a silent drop.
  const orphan = await cli("note", "nobody to attach to");
  expect(orphan.code).toBe(1);
  expect(orphan.stderr).toContain("nothing is running");

  const notes = store!.sessionNotes();
  expect(notes.map(n => n.text)).toEqual(["reviewed the provider auth", "also patched the report"]);
  expect(notes.every(n => !/[\u0000-\u001f]/.test(n.text))).toBe(true);
});

test("session list and remove work through the CLI with visible provenance", async () => {
  setup();
  const started = JSON.parse((await cli("session", "start", "--project", "coral")).stdout) as { session: string };
  await cli("session", "stop", "--note", "testing removal");

  // A running session refuses removal; a stopped one needs a reason.
  const second = JSON.parse((await cli("session", "start", "--project", "coral")).stdout) as { session: string };
  const openRemove = await cli("session", "remove", "--session", second.session, "--reason", "too soon");
  expect(openRemove.code).toBe(1);
  expect(openRemove.stderr).toContain("stopped");
  await cli("session", "stop");

  const list = JSON.parse(JSON.stringify((await cli("session", "list")).stdout));
  expect(list).toContain(started.session);
  const noReason = await cli("session", "remove", "--session", started.session);
  expect(noReason.code).toBe(1);
  expect(noReason.stderr).toContain("reason");

  const removed = JSON.parse((await cli("session", "remove", "--session", started.session, "--reason", "agent verification noise")).stdout) as { removed: boolean; reason: string };
  expect(removed).toMatchObject({ removed: true, reason: "agent verification noise" });

  // The cached projection invalidates: attested hours drop in the next status.
  const status = JSON.parse((await cli("status")).stdout) as { measures: { attested: { union_ms: number } } };
  expect(status.measures.attested.union_ms).toBeLessThan(60_000);

  // The day report names the correction instead of hiding it.
  const day = await cli("day", "--tz", "UTC");
  expect(day.stdout).toContain("removed session(s) (corrected)");
});

test("a second daemon refuses to take over a live socket", async () => {
  setup();
  await expect(startDaemon({ store: new WorkspanStore(join(roots[0], "second.sqlite")), runtimeDir, idleGapMs: 900_000 })).rejects.toThrow(/already listening/);
});

test("the CLI fails with a bounded message when no daemon is running", async () => {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/workspan.ts"), "--socket", join(tmpdir(), "workspan-absent", "workspan.sock"), "status"], { stdout: "pipe", stderr: "pipe" });
  const [stderr] = await Promise.all([new Response(proc.stderr).text(), new Response(proc.stdout).text()]);
  expect(await proc.exited).toBe(1);
  expect(stderr).toContain("cannot reach the Workspan daemon");
});

test("a review note lands on the session the idle stretch happened in", async () => {
  setup();
  // A corrected session whose interval covers the stretch, and nothing open when the
  // review happens: this is the delayed case the popup nudge asks about.
  const t0 = Date.now() - 3 * 3_600_000;
  const started = JSON.parse((await cli("session", "start", "--project", "coral", "--at", String(t0))).stdout) as { session: string };
  await cli("session", "stop", "--at", String(t0 + 600_000));

  const idleAt = t0 + 300_000;
  const resumedAt = t0 + 420_000;
  const file = join(roots[0], "idle.jsonl");
  writeFileSync(file, [
    JSON.stringify({ v: 1, source: "desktop", instance: "omarchy", session: "omarchy", event: `idle:${idleAt}:300000`, kind: "interaction", at: idleAt, origin: "unknown" }),
    JSON.stringify({ v: 1, source: "desktop", instance: "omarchy", session: "omarchy", event: `resumed:${resumedAt}:300000`, kind: "interaction", at: resumedAt, origin: "unknown" }),
  ].join("\n") + "\n");
  expect(JSON.parse((await cli("ingest", "--file", file)).stdout)).toMatchObject({ accepted: 2, conflicts: 0 });

  const before = JSON.parse((await cli("status")).stdout) as { measures: { attested: { union_ms: number } } };
  const review = JSON.parse((await cli("note", "lunch with the client", "--idle")).stdout) as { session: string; project: string | null; idle: { from: number; to: number } };
  expect(review.session).toBe(started.session);
  expect(review.project).toBe("coral");
  // The stretch began at the notification minus the timeout it waited out.
  expect(review.idle).toEqual({ from: idleAt - 300_000, to: resumedAt });

  // The note is an annotation: it closed nothing and moved no measure.
  const after = JSON.parse((await cli("status")).stdout) as { measures: { attested: { union_ms: number } } };
  expect(after.measures.attested.union_ms).toBe(before.measures.attested.union_ms);
  const dayKey = new Date(t0).toISOString().slice(0, 10);
  const day = await cli("day", "--tz", "UTC", "--date", dayKey);
  expect(day.stdout).toContain("lunch with the client");

  // A stretch no session covers is refused rather than attributed to a neighbour.
  const gap = Date.now() - 2 * 3_600_000;
  const uncovered = join(roots[0], "uncovered.jsonl");
  writeFileSync(uncovered, [
    JSON.stringify({ v: 1, source: "desktop", instance: "omarchy", session: "omarchy", event: `idle:${gap}:30000`, kind: "interaction", at: gap, origin: "unknown" }),
    JSON.stringify({ v: 1, source: "desktop", instance: "omarchy", session: "omarchy", event: `resumed:${gap + 60_000}:30000`, kind: "interaction", at: gap + 60_000, origin: "unknown" }),
  ].join("\n") + "\n");
  await cli("ingest", "--file", uncovered);
  const orphan = await cli("note", "nobody covers this", "--idle");
  expect(orphan.code).toBe(1);
  expect(orphan.stderr).toContain("no_covering_session");
});

test("a session boundary can be stated afterwards, and the report says so", async () => {
  setup();
  const t0 = Date.now() - 5 * 3_600_000;
  const started = JSON.parse((await cli("session", "start", "--project", "coral", "--at", String(t0))).stdout) as { started_at: number; corrected: boolean; recorded_at: number };
  expect(started.started_at).toBe(t0);
  expect(started.corrected).toBe(true);
  expect(started.recorded_at).toBeGreaterThan(t0);

  const before = JSON.parse((await cli("status")).stdout) as { measures: { attested: { union_ms: number } } };
  const stopped = JSON.parse((await cli("session", "stop", "--at", String(t0 + 3_600_000))).stdout) as { stopped_at: number; corrected: boolean };
  expect(stopped.stopped_at).toBe(t0 + 3_600_000);
  expect(stopped.corrected).toBe(true);

  const after = JSON.parse((await cli("status")).stdout) as { measures: { attested: { union_ms: number } } };
  // The stated hour is attested - the person's own claim is the evidence - and the
  // union grew by exactly that hour, because nothing else covers those minutes.
  expect(after.measures.attested.union_ms - before.measures.attested.union_ms).toBe(3_600_000);

  const dayKey = new Date(t0).toISOString().slice(0, 10);
  const day = await cli("day", "--tz", "UTC", "--date", dayKey);
  expect(day.stdout).toContain("1h 00m");
  expect(day.stdout).toContain("(recorded later)");

  // A moment that has not happened is refused, and nothing is recorded by it.
  const future = await cli("session", "start", "--at", String(Date.now() + 60_000));
  expect(future.code).toBe(1);
  expect(future.stderr).toContain("future");

  // A stop cannot be recorded before its own session started.
  await cli("session", "start", "--project", "coral");
  const backwards = await cli("session", "stop", "--at", String(Date.now() - 6 * 3_600_000));
  expect(backwards.code).toBe(1);
  expect(backwards.stderr).toContain("before the session started");
  await cli("session", "stop");
});

afterAll(async () => { if (daemon) await daemon.close(); for (const root of roots) rmSync(root, { recursive: true, force: true }); });
