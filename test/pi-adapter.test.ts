import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WorkspanStore } from "../src/daemon/db.ts";
import { readStatusFile, startDaemon, type Daemon } from "../src/daemon/server.ts";
import { WorkspanEmitter, drainOrphanedSpools, isHumanInput, repositoryRoot, TICK_MS } from "../adapters/pi/index.ts";

const roots: string[] = [];
let daemon: Daemon | null = null;
let store: WorkspanStore | null = null;
let runtimeDir = "";
let spoolPath = "";
let emitter: WorkspanEmitter | null = null;
let prepared = false;
const root = "/tmp/workspan-adapter-repo";
const base = 1_700_000_000_000;

// ---- presence decoding: inherited corpus, same expectations ----

test("presence decoding separates work from terminal chatter", () => {
  expect(isHumanInput("a")).toBe(true);
  expect(isHumanInput("\r")).toBe(true);
  expect(isHumanInput("hello typed text")).toBe(true);
  expect(isHumanInput("\x1b[200~pasted content\x1b[201~")).toBe(true);
  expect(isHumanInput("")).toBe(false);
  expect(isHumanInput("\x1b[I")).toBe(false);
  expect(isHumanInput("\x1b[O")).toBe(false);
  expect(isHumanInput("\x1b[<0;12;3M")).toBe(false);
  expect(isHumanInput("\x1b]52;c:aGVsbG8\x07")).toBe(false);
  expect(isHumanInput("\x1b[?1;2c")).toBe(false);
});

test("the workspace root walks up to the repository", () => {
  const dir = mkdtempSync(join(tmpdir(), "adapter-root-"));
  roots.push(dir);
  mkdirSync(join(dir, ".git"));
  mkdirSync(join(dir, "nested", "deep"), { recursive: true });
  expect(repositoryRoot(join(dir, "nested", "deep"))).toBe(dir);
  const bare = mkdtempSync(join(tmpdir(), "adapter-bare-"));
  roots.push(bare);
  expect(repositoryRoot(bare)).toBe(bare);
});

// ---- delivery and measures, against a real daemon ----

function setup() {
  if (prepared) return;
  prepared = true;
  const dir = mkdtempSync(join(tmpdir(), "workspan-adapter-"));
  roots.push(dir);
  runtimeDir = join(dir, "run");
  spoolPath = join(dir, "pi-spool.jsonl");
  store = new WorkspanStore(join(dir, "workspan.sqlite"));
  emitter = new WorkspanEmitter({ socketPath: join(runtimeDir, "workspan.sock"), instance: "test-host", spoolPath });
}

// startDaemon is async; the integration tests await it through this helper.
let daemonPromise: Promise<Daemon> | null = null;

async function ensureDaemon(): Promise<Daemon> {
  if (!daemonPromise) {
    daemonPromise = startDaemon({ store: store!, runtimeDir, idleGapMs: 900_000 }).then(started => {
      daemon = started;
      return started;
    });
  }
  return daemonPromise;
}

test("ticks and turns become separate measures, with the root recorded", async () => {
  setup();
  const d = await ensureDaemon();
  void d;
  emitter!.emit({ what: "tick", at: base, session: "s1", root });
  emitter!.emit({ what: "tick", at: base + 5_000, session: "s1", root });
  emitter!.emit({ what: "turn-start", at: base + 60_000, session: "s1", root });
  emitter!.emit({ what: "turn-end", at: base + 120_000, session: "s1", root });
  // A settled turn is also presence: the window continues while the human reads.
  emitter!.emit({ what: "tick", at: base + 120_000, session: "s1", root });
  await emitter!.flush();

  const status = readStatusFile(runtimeDir);
  // Two ticks five seconds apart, then a 55s pause to the settled turn: one window.
  expect(status.measures.inferred.union_ms).toBe(120_000);
  expect(status.measures.agent.union_ms).toBe(60_000);
  // No binding exists, so the evidence is unallocated, and the root is recorded
  // for the moment one is confirmed.
  expect(status.measures.inferred.unallocated_ms).toBe(120_000);
  const windows = store!.windows();
  expect(windows).toHaveLength(1);
  expect(windows[0].root).toBe(root);
  expect(windows[0].client).toBe("unallocated");
});

test("a confirmed binding attributes new evidence, and never re-attributes recorded rows", async () => {
  setup();
  store!.bindProject(root, "coral", true, "test");
  emitter!.emit({ what: "tick", at: base + 300_000, session: "s1", root });
  emitter!.emit({ what: "tick", at: base + 305_000, session: "s1", root });
  emitter!.emit({ what: "tick", at: base + 400_000, session: "s1", root });
  await emitter!.flush();
  const status = readStatusFile(runtimeDir);
  // Inherited semantics: a client change opens a fresh window at the next
  // observation, and the earlier window keeps its own attribution.
  const windows = store!.windows();
  expect(windows).toHaveLength(2);
  expect(windows[0]).toMatchObject({ client: "unallocated", start: base, end: base + 120_000 });
  expect(windows[1]).toMatchObject({ client: "coral", start: base + 300_000, end: base + 400_000 });
  expect(status.measures.inferred.union_ms).toBe(220_000);
  expect(status.measures.inferred.projects).toEqual([{ project: "coral", ms: 100_000 }]);
  expect(status.measures.inferred.unallocated_ms).toBe(120_000);
});

test("evidence survives the daemon being down, and drains on restart", async () => {
  // A second emitter, pointed at a socket nobody is listening on yet.
  const offlineDir = mkdtempSync(join(tmpdir(), "workspan-offline-"));
  roots.push(offlineDir);
  const offlineSpool = join(offlineDir, "spool.jsonl");
  const offline = new WorkspanEmitter({ socketPath: join(offlineDir, "missing.sock"), instance: "test-host", spoolPath: offlineSpool });
  offline.emit({ what: "tick", at: base + 600_000, session: "s2", root });
  await expect(offline.flush()).rejects.toThrow();
  // The spool still holds the event; draining it into the live daemon works.
  const drain = new WorkspanEmitter({ socketPath: join(runtimeDir, "workspan.sock"), instance: "test-host", spoolPath: offlineSpool });
  await drain.flush();
  const status = readStatusFile(runtimeDir);
  // Ticks inside the same ten-second bucket share an identity, so the count is
  // unique observations, not emitted lines: 4, then 2 more, then this one.
  expect(status.coverage.events).toBe(7);
});

test("two terminals in two projects stay separate sessions with per-root attribution", async () => {
  setup();
  const secondRoot = "/tmp/workspan-adapter-repo-b";
  store!.bindProject(secondRoot, "beacon", true, "test");
  const second = new WorkspanEmitter({ socketPath: join(runtimeDir, "workspan.sock"), instance: "test-host", spoolPath: spoolPath + ".b" });
  // Two Pi processes - two terminals - each with its own session id and its own
  // repository. Their evidence must never collapse into one session.
  emitter!.emit({ what: "tick", at: base + 500_000, session: "terminal-a", root });
  emitter!.emit({ what: "tick", at: base + 510_000, session: "terminal-a", root });
  second.emit({ what: "tick", at: base + 520_000, session: "terminal-b", root: secondRoot });
  second.emit({ what: "tick", at: base + 530_000, session: "terminal-b", root: secondRoot });
  await emitter!.flush();
  await second.flush();

  const windows = store!.windows().filter(w => w.sessionId.startsWith("terminal-"));
  expect(windows).toHaveLength(2);
  expect(windows.map(w => [w.sessionId, w.client])).toEqual([["terminal-a", "coral"], ["terminal-b", "beacon"]]);
  const status = readStatusFile(runtimeDir);
  // Earlier tests in this file already attributed coral evidence, so assert the new
  // terminal's contribution rather than the cumulative total.
  expect(status.measures.inferred.projects).toEqual(expect.arrayContaining([{ project: "beacon", ms: 10_000 }]));
  expect(status.measures.inferred.projects.find(p => p.project === "coral")?.ms).toBeGreaterThanOrEqual(10_000);
  expect(status.measures.inferred.union_ms).toBeGreaterThanOrEqual(20_000);
});

test("a dead process's undrained evidence is recovered; a live one's is not touched", async () => {
  setup();
  await ensureDaemon();
  const evidence = JSON.stringify({ v: 1, source: "pi", instance: "test-host", session: "orphan", event: "orphan-1", kind: "interaction", at: base + 900_000, origin: "human" }) + "\n";
  const dead = Bun.spawn(["sleep", "0.05"]);
  await dead.exited;
  const orphan = join(dirname(spoolPath), "pi-spool-" + dead.pid + ".jsonl");
  writeFileSync(orphan, evidence);
  await drainOrphanedSpools(join(runtimeDir, "workspan.sock"), dirname(spoolPath));
  expect(existsSync(orphan)).toBe(false);
  expect(store!.observations().some(o => o.event === "orphan-1")).toBe(true);

  const alive = Bun.spawn(["sleep", "30"]);
  const owned = join(dirname(spoolPath), "pi-spool-" + alive.pid + ".jsonl");
  writeFileSync(owned, evidence);
  await drainOrphanedSpools(join(runtimeDir, "workspan.sock"), dirname(spoolPath));
  // A live process owns its spool: nobody else drains it out from under it.
  expect(existsSync(owned)).toBe(true);
  alive.kill();
  rmSync(owned, { force: true });
});

test("a tick inside the same bucket is one identity, so a redelivery adds nothing", async () => {
  setup();
  emitter!.emit({ what: "tick", at: base + 400_000, session: "s1", root });
  emitter!.emit({ what: "tick", at: base + 400_000 + TICK_MS / 2, session: "s1", root });
  await emitter!.flush();
  const before = store!.observations().length;
  await emitter!.flush();
  expect(store!.observations().length).toBe(before);
});

afterAll(async () => {
  if (daemon) await daemon.close();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
