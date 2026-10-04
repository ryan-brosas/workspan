import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../src/cli/doctor.ts";
import { WorkspanStore } from "../src/daemon/db.ts";
import { readStatusFile, startDaemon, type Daemon } from "../src/daemon/server.ts";
import type { HarnessProbe, HarnessReader } from "../src/adapters/harness.ts";
import type { EvidenceEvent } from "../src/daemon/evidence.ts";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "workspan-harness-"));
  roots.push(root);
  const runtimeDir = join(root, "run");
  return { root, runtimeDir, socketPath: join(runtimeDir, "workspan.sock"), databasePath: join(root, "workspan.sqlite") };
}

const base = 1_700_000_000_000;
const turn = (at: number, id: string): EvidenceEvent => ({ source: "codex", instance: "local", session: "codex-thread", event: `turn-${id}`, kind: "agent-start", at, origin: "unknown" });

/**
 * A harness store that lives only in the test. The daemon must not care which
 * harness a reader belongs to: it detects, imports and reports the store it is
 * given, and a reader that is missing or broken stays visible.
 */
function fixtureReader(options: { id?: string; events?: EvidenceEvent[]; store?: string | null; throws?: boolean; lastEventAt?: number } = {}): HarnessReader {
  const id = options.id ?? "fixture";
  const store = options.store === undefined ? "/fixture/store.sqlite" : options.store;
  const events = options.events ?? [];
  const probe = (): HarnessProbe => ({ store, storeMtime: null, lastEventAt: options.lastEventAt ?? null, staleDays: null });
  return {
    id,
    source: "codex",
    probe,
    read: () => {
      if (options.throws) throw new Error("unreadable store");
      return { events, summary: { ...probe(), events: events.length, from: null, to: null } };
    },
  };
}

/** The real CLI in its own process, awaited so the in-process daemon can answer. */
async function cli(runtimeDir: string, ...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/workspan.ts"), "--socket", join(runtimeDir, "workspan.sock"), ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr };
}

async function waitFor<T>(read: () => T | null, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test("a daemon pass detects each store, imports what it found, and a replay adds nothing", async () => {
  const { runtimeDir, databasePath } = scratch();
  const events = [turn(base, "a"), turn(base + 60_000, "b")];
  const store = new WorkspanStore(databasePath);
  const daemon: Daemon = await startDaemon({
    store, runtimeDir, idleGapMs: 900_000,
    harnessPollMs: 120, harnessWindowMs: 7 * 86_400_000,
    harnessReaders: [fixtureReader({ events, lastEventAt: events[1]!.at })],
  });
  try {
    const first = readStatusFile(runtimeDir).harness!;
    expect(first.interval_ms).toBe(120);
    expect(first.readers).toHaveLength(1);
    const reader = first.readers[0]!;
    expect(reader.available).toBe(true);
    expect(reader.store).toBe("/fixture/store.sqlite");
    expect(reader.last_event_at).toBe(base + 60_000);
    expect(reader.events).toBe(2);
    expect(reader.accepted).toBe(2);
    expect(reader.duplicates).toBe(0);
    expect(readStatusFile(runtimeDir).coverage.sources.find(source => source.source === "codex")?.events).toBe(2);

    // The next pass sees the same turns again: replay is safe, and the pass reports
    // duplicates instead of accepting them twice or hiding that it saw them.
    const later = await waitFor(() => {
      const row = readStatusFile(runtimeDir).harness?.readers[0];
      return row && row.duplicates === 2 ? row : null;
    });
    expect(later.accepted).toBe(0);
    expect(readStatusFile(runtimeDir).coverage.sources.find(source => source.source === "codex")?.events).toBe(2);
  } finally { await daemon.close(); }
});

test("a missing store is unavailable, and a broken reader never hides the others", async () => {
  const { runtimeDir, databasePath } = scratch();
  const store = new WorkspanStore(databasePath);
  const daemon: Daemon = await startDaemon({
    store, runtimeDir, idleGapMs: 900_000, harnessPollMs: 600_000, harnessWindowMs: 86_400_000,
    harnessReaders: [
      fixtureReader({ id: "absent", store: null }),
      fixtureReader({ id: "broken", throws: true }),
      fixtureReader({ id: "present", events: [turn(base, "c")] }),
    ],
  });
  try {
    const harness = readStatusFile(runtimeDir).harness!;
    const byId = Object.fromEntries(harness.readers.map(reader => [reader.id, reader]));
    // Absence of a harness is not zero activity, and it is not a fault either.
    expect(byId.absent!.available).toBe(false);
    expect(byId.absent!.store).toBeNull();
    expect(byId.absent!.events).toBe(0);
    expect(byId.absent!.error).toBeNull();
    // A store that cannot be read is named, while the readable one still lands.
    expect(byId.broken!.error).toContain("unreadable store");
    expect(byId.present!.accepted).toBe(1);
    expect(harness.error).toBeNull();
    expect(readStatusFile(runtimeDir).coverage.sources.find(source => source.source === "codex")?.events).toBe(1);

    const report = await runDoctor({ runtimeDir, databasePath });
    const check = report.checks.find(candidate => candidate.name === "harness detection");
    expect(check?.state).toBe("attention");
    expect(check?.detail).toContain("broken");
  } finally { await daemon.close(); }
});

test("detection can be switched off, and doctor says which mode the daemon is in", async () => {
  const { runtimeDir, databasePath } = scratch();
  const store = new WorkspanStore(databasePath);
  const daemon: Daemon = await startDaemon({
    store, runtimeDir, idleGapMs: 900_000, harnessPollMs: 0,
    harnessReaders: [fixtureReader({ events: [turn(base, "d")] })],
  });
  try {
    const harness = readStatusFile(runtimeDir).harness!;
    expect(harness.interval_ms).toBe(0);
    expect(harness.readers).toEqual([]);
    expect(readStatusFile(runtimeDir).coverage.sources.some(source => source.source === "codex")).toBe(false);

    const check = (await runDoctor({ runtimeDir, databasePath })).checks.find(candidate => candidate.name === "harness detection");
    expect(check?.state).toBe("ok");
    expect(check?.detail).toContain("off");
  } finally { await daemon.close(); }
});

test("doctor sees a stopped scan, and the CLI reports detection plus the automatic pass", async () => {
  const { runtimeDir, databasePath } = scratch();
  const store = new WorkspanStore(databasePath);
  const daemon: Daemon = await startDaemon({
    store, runtimeDir, idleGapMs: 900_000, harnessPollMs: 600_000, harnessWindowMs: 86_400_000,
    harnessReaders: [fixtureReader({ events: [turn(base, "e")] })],
  });
  try {
    const fresh = await runDoctor({ runtimeDir, databasePath });
    expect(fresh.checks.find(candidate => candidate.name === "harness detection")?.state).toBe("ok");

    // Three missed intervals is the fault the status block exposes rather than
    // smoothing into "nothing found": the same arithmetic against a later clock.
    const stale = await runDoctor({ runtimeDir, databasePath, now: Date.now() + 3 * 600_000 + 60_000 });
    const check = stale.checks.find(candidate => candidate.name === "harness detection");
    expect(check?.state).toBe("attention");
    expect(check?.detail).toContain("the scan stopped");

    // The public command still probes every real reader, and names the automatic
    // mode instead of leaving "never scanned" to look like "nothing found".
    const result = await cli(runtimeDir, "harness");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as { readers: unknown[]; automatic: { interval_ms: number; polled_at: number | null; readers: Array<{ id: string }> } };
    expect(parsed.readers).toHaveLength(3);
    expect(parsed.automatic.interval_ms).toBe(600_000);
    expect(parsed.automatic.polled_at).not.toBeNull();
    expect(parsed.automatic.readers.map(reader => reader.id)).toEqual(["fixture"]);
  } finally { await daemon.close(); }
});
