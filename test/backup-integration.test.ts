import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspanStore } from "../src/daemon/db.ts";
import { startDaemon } from "../src/daemon/server.ts";
import { WorkspanClient } from "../src/client.ts";

test("backup under ongoing IPC ingestion restores a consistent snapshot into an isolated daemon", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-backup-integration-")), base = Date.parse("2026-10-03T10:00:00Z");
  const store = new WorkspanStore(join(dir, "db.sqlite"));
  store.ingest({ source: "manual", instance: "fixture", session: "s", event: "start", kind: "session-start", origin: "attested", at: base });
  store.ingest({ source: "manual", instance: "fixture", session: "s", event: "stop", kind: "session-stop", origin: "attested", at: base + 1234 });
  // An explicit spool directory: the default is shared state, and this test must never
  // drain (or depend on) a real collector's pending evidence.
  const daemon = await startDaemon({ store, runtimeDir: join(dir, "run"), spoolDir: join(dir, "spools") });
  const client = new WorkspanClient({ socketPath: daemon.socketPath });
  const acknowledged: number[] = [];
  let failure: unknown = null;
  const ingesting = (async () => {
    for (let i = 0; i < 20; i++) {
      await client.ingest([{ v: 1, source: "desktop", instance: "fixture", session: "seat", event: `e-${i}`, kind: "interaction", origin: "unknown", at: base + 2000 + i }]);
      acknowledged.push(i);
      await Bun.sleep(2);
    }
  })();
  // A rejection while the test awaits the backup must be reported by this test, not left
  // as an unhandled rejection that fails the run with an unrelated message.
  const ingested = ingesting.catch(error => { failure = error; });
  try {
    // Deterministic instead of a fixed sleep: wait until one IPC ingest has committed,
    // so the snapshot is guaranteed to be taken mid-ingestion at any runner speed.
    while (!acknowledged.length) await Bun.sleep(1);
    const backup = await client.request("backup", { keep: 2 }) as { path: string; identities: number; revision: number };
    await ingested;
    if (failure) throw failure;
    expect(store.observations()).toHaveLength(22);
    expect(backup.identities).toBeGreaterThan(2);
    expect(backup.identities).toBeLessThanOrEqual(22);
    const target = join(dir, "restored.sqlite"); copyFileSync(backup.path, target);
    const restored = new WorkspanStore(target);
    const isolated = await startDaemon({ store: restored, runtimeDir: join(dir, "restore-run"), spoolDir: join(dir, "restore-spools") });
    try {
      expect(restored.observations()).toHaveLength(backup.identities);
      expect(restored.revision()).toBe(backup.revision);
      const facts = JSON.parse(await new WorkspanClient({ socketPath: isolated.socketPath }).report({ period: "day", date: "2026-10-03", timezone: "UTC", format: "json" }));
      expect(facts.measures.attested.union_ms).toBe(1234);
      expect(facts.measures.inferred.union_ms).toBe(0);
      expect(facts.measures.agent.union_ms).toBe(0);
    } finally { await isolated.close(); }
  } finally { await ingested; await daemon.close(); rmSync(dir, { recursive: true, force: true }); }
});
