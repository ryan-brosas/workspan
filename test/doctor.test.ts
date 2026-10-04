import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../src/cli/doctor.ts";
import { WorkspanStore } from "../src/daemon/db.ts";
import { startDaemon, type Daemon } from "../src/daemon/server.ts";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "workspan-doctor-"));
  roots.push(root);
  const runtimeDir = join(root, "run");
  return { root, runtimeDir, socketPath: join(runtimeDir, "workspan.sock"), databasePath: join(root, "workspan.sqlite") };
}

test("doctor reports a wired host, a stuck spool and a dead daemon", async () => {
  const { runtimeDir, socketPath, databasePath } = scratch();
  const store = new WorkspanStore(databasePath);
  const daemon: Daemon = await startDaemon({ store, runtimeDir, idleGapMs: 900_000 });
  try {
    const healthy = await runDoctor({ socketPath, runtimeDir, databasePath });
    expect(healthy.checks.find(check => check.name === "socket")?.state).toBe("ok");
    expect(healthy.checks.find(check => check.name === "daemon")?.state).toBe("ok");
    expect(healthy.checks.find(check => check.name === "status file")?.state).toBe("ok");
    expect(healthy.checks.find(check => check.name === "database")?.state).toBe("ok");

    // Evidence waiting in the spool means the daemon has not accepted a batch.
    writeFileSync(join(runtimeDir, "collector.pending"), '{"v":1}\n');
    const stuck = await runDoctor({ socketPath, runtimeDir, databasePath });
    expect(stuck.checks.find(check => check.name === "collector spool")?.state).toBe("attention");
    expect(stuck.verdict).toBe("attention");
  } finally { await daemon.close(); }

  const dead = await runDoctor({ socketPath, runtimeDir, databasePath });
  expect(dead.checks.find(check => check.name === "daemon")?.state).toBe("attention");
  expect(dead.checks.find(check => check.name === "socket")?.state).toBe("attention");
  expect(dead.verdict).toBe("attention");
});

test("doctor tells a quiet seat from a stopped ingest loop, and sees stranded evidence", async () => {
  const { runtimeDir, socketPath, databasePath } = scratch();
  const spoolDir = join(runtimeDir, "spools");
  mkdirSync(spoolDir, { recursive: true });
  const store = new WorkspanStore(databasePath);
  const daemon: Daemon = await startDaemon({ store, runtimeDir, idleGapMs: 900_000 });
  try {
    // No heartbeat yet: the loop has not run in this session, which is unknown, not bad.
    const missing = await runDoctor({ socketPath, runtimeDir, databasePath, spoolDir });
    expect(missing.checks.find(check => check.name === "collector heartbeat")?.state).toBe("unknown");
    expect(missing.checks.find(check => check.name === "adapter spools")?.state).toBe("ok");

    writeFileSync(join(runtimeDir, "collector.health"), String(Date.now()));
    const fresh = await runDoctor({ socketPath, runtimeDir, databasePath, spoolDir });
    expect(fresh.checks.find(check => check.name === "collector heartbeat")?.state).toBe("ok");

    // The collector emits nothing while nothing changes, so only the heartbeat can
    // say the lane stopped: three missed passes is a fault, not a quiet person.
    writeFileSync(join(runtimeDir, "collector.health"), String(Date.now() - 120_000));
    const stale = await runDoctor({ socketPath, runtimeDir, databasePath, spoolDir });
    expect(stale.checks.find(check => check.name === "collector heartbeat")?.state).toBe("attention");
    expect(stale.verdict).toBe("attention");

    // An empty spool is litter; a spool holding bytes is evidence that has not arrived.
    writeFileSync(join(spoolDir, "pi-spool-9000001.jsonl"), "");
    const litter = await runDoctor({ socketPath, runtimeDir, databasePath, spoolDir });
    expect(litter.checks.find(check => check.name === "adapter spools")?.state).toBe("ok");
    writeFileSync(join(spoolDir, "pi-spool-9000002.jsonl"), '{"v":1}\n');
    const pending = await runDoctor({ socketPath, runtimeDir, databasePath, spoolDir });
    expect(pending.checks.find(check => check.name === "adapter spools")?.state).toBe("attention");
    writeFileSync(join(spoolDir, "pi-spool-9000003.jsonl.loss"), JSON.stringify({ code: "evidence_spool_full", at: Date.now() }));
    const refused = await runDoctor({ socketPath, runtimeDir, databasePath, spoolDir });
    const delivery = refused.checks.find(check => check.name === "evidence delivery");
    expect(delivery?.state).toBe("attention");
    // The marker names the failure: the pending spool from the check above is still there,
    // so "attention" alone could not be attributed to the loss record.
    expect(delivery?.detail).toContain("evidence_spool_full");
  } finally { await daemon.close(); }
});
