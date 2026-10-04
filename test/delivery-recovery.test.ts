import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EvidenceSpool, drainOrphanedSpools } from "../src/client.ts";
import { WorkspanStore } from "../src/daemon/db.ts";
import { startDaemon } from "../src/daemon/server.ts";
const base = 1_700_000_000_000;
const event = (i: number) => ({ v: 1, source: "pi", instance: "fixture", session: "s", event: `e-${i}`, kind: "interaction", at: base + i * 60_000, origin: "human", root: "/fixture" });
const line = (i: number) => JSON.stringify(event(i)) + "\n";
function fixture() { const dir = mkdtempSync(join(tmpdir(), "ws-recovery-test-")); return { dir, store: new WorkspanStore(join(dir, "db.sqlite")) }; }

test("flush drains pre-existing pending and active snapshots, including a missing final newline", async () => {
  const { dir, store } = fixture();
  const daemon = await startDaemon({ store, runtimeDir: join(dir, "run"), spoolDir: join(dir, "unused") });
  const path = join(dir, `pi-spool-${process.pid}.jsonl`);
  writeFileSync(path + ".pending", line(0).trimEnd()); writeFileSync(path, line(1));
  const spool = new EvidenceSpool({ spoolPath: path, socketPath: daemon.socketPath });
  try {
    expect(await spool.flush()).toBe(2);
    expect(spool.pendingBytes).toBe(0);
    expect(store.observations()).toHaveLength(2);
    expect(daemon.status().measures.inferred.union_ms).toBe(60_000);
  } finally { spool.dispose(); await daemon.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("separate processes claim the whole orphan family and preserve chronological attendance", async () => {
  const { dir, store } = fixture();
  const daemon = await startDaemon({ store, runtimeDir: join(dir, "run"), spoolDir: join(dir, "unused") });
  try {
    const path = join(dir, "pi-spool-9000001.jsonl");
    writeFileSync(path + ".pending", line(0) + line(1)); writeFileSync(path, line(2));
    const code = `import { drainOrphanedSpools } from ${JSON.stringify(join(import.meta.dir, "../src/client.ts"))}; console.log(await drainOrphanedSpools(${JSON.stringify({directory: dir, socketPath: daemon.socketPath})}));`;
    const children = [0, 1].map(() => Bun.spawn([process.execPath, "--eval", code], { stdout: "pipe", stderr: "pipe" }));
    const results = await Promise.all(children.map(async child => ({ code: await child.exited, out: await new Response(child.stdout).text(), err: await new Response(child.stderr).text() })));
    expect(results.every(result => result.code === 0 && result.err === "")).toBe(true);
    expect(results.reduce((sum, result) => sum + Number(result.out), 0)).toBe(3);
    expect(store.observations()).toHaveLength(3);
    expect(daemon.status().measures.inferred.union_ms).toBe(120_000);
    expect(store.conflictRows()).toHaveLength(0);
  } finally { await daemon.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a crash between sibling renames keeps the older snapshot in the same recoverable family", async () => {
  const { dir, store } = fixture();
  const path = join(dir, "pi-spool-9000001.jsonl");
  writeFileSync(join(dir, "pi-spool-9000001-recovery-owner-9000002-00000000-0000-4000-8000-000000000000.jsonl.pending"), line(0) + line(1));
  writeFileSync(path, line(2));
  const daemon = await startDaemon({ store, runtimeDir: join(dir, "run") });
  try {
    await drainOrphanedSpools({ directory: dir, socketPath: daemon.socketPath });
    await daemon.close();
    expect(daemon.status().coverage.events).toBe(3);
    expect(daemon.status().measures.inferred.union_ms).toBe(120_000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a receipted conflict retires, and a malformed record stays visible without blocking later valid evidence", async () => {
  const { dir, store } = fixture();
  const daemon = await startDaemon({ store, runtimeDir: join(dir, "run"), spoolDir: join(dir, "unused") });
  const path = join(dir, "pi-spool-9000001.jsonl"), notices: string[] = [];
  const spool = new EvidenceSpool({ spoolPath: path, socketPath: daemon.socketPath, onFull: message => notices.push(message) });
  try {
    spool.append(event(0)); spool.append({ ...event(0), at: base + 1234 });
    // The second record can never be accepted. The daemon receipts it as a conflict
    // and records it for review, so the queue retires it instead of retrying forever.
    expect(await spool.flush()).toBe(2);
    expect(spool.lines()).toHaveLength(0);
    expect(store.observations()).toHaveLength(1);
    expect(store.conflictRows()).toHaveLength(1);

    writeFileSync(path + ".pending", "{malformed-PRIVATE}\n");
    expect(spool.append({ ...event(1), prompt: "DO-NOT-STORE" })).toBe(false);
    expect(spool.lines().join("\n")).not.toContain("DO-NOT-STORE");
    expect(existsSync(path + ".loss")).toBe(true);
    spool.append(event(1));
    await expect(spool.flush()).rejects.toThrow("spool_invalid");
    expect(store.observations()).toHaveLength(2);
    // A malformed record has no receipt, so it is retained: never silently dropped.
    expect(spool.lines()).toHaveLength(1);
    expect(spool.lines().join("\n")).toContain("malformed-PRIVATE");
    expect(notices.join("\n")).not.toContain("PRIVATE");
    expect(existsSync(path + ".error")).toBe(true);
  } finally { spool.dispose(); await daemon.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a failed status write cannot disable autonomous evidence recovery", async () => {
  const { dir, store } = fixture();
  const daemon = await startDaemon({ store, runtimeDir: join(dir, "run"), statusIntervalMs: 1000 });
  const failed = daemon.statusPath + ".tmp";
  try {
    await Bun.sleep(25);
    mkdirSync(failed);
    writeFileSync(join(dir, "pi-spool-9000001.jsonl"), line(0));
    await Bun.sleep(1200);
    expect(store.observations()).toHaveLength(1);
    rmSync(failed, { recursive: true });
  } finally { rmSync(failed, { recursive: true, force: true }); await daemon.close(); rmSync(dir, { recursive: true, force: true }); }
});
