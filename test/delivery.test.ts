import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { EvidenceSpool, drainOrphanedSpools } from "../src/client.ts";
import { runDoctor } from "../src/cli/doctor.ts";
import { WorkspanStore } from "../src/daemon/db.ts";
import { startDaemon } from "../src/daemon/server.ts";

const event = (i: number) => ({ v: 1, source: "desktop", instance: "fixture", session: "s", event: `e-${i}`, kind: "interaction", at: 1_700_000_000_000 + i, origin: "unknown" });

test("an append during acknowledgement is retained, and concurrent flushes share a drain", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-delivery-"));
  let received!: () => void;
  const ready = new Promise<void>(resolve => { received = resolve; });
  let ack!: () => void;
  const sent: unknown[] = [];
  const server = createServer(socket => socket.once("data", chunk => {
    const req = JSON.parse(chunk.toString());
    sent.push(...req.params.events);
    ack = () => socket.end(JSON.stringify({ id: req.id, ok: true, result: { accepted: req.params.events.length, duplicates: 0, conflicts: 0 } }) + "\n");
    received();
  }));
  const socketPath = join(dir, "socket");
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  const spool = new EvidenceSpool({ spoolPath: join(dir, "pi-spool-4242.jsonl"), socketPath });
  try {
    spool.append(event(1));
    const first = spool.flush();
    const second = spool.flush();
    await ready;
    spool.append(event(2));
    ack();
    await Promise.all([first, second]);
    expect(sent).toHaveLength(1);
    expect(spool.lines().map(line => JSON.parse(line).event)).toEqual(["e-2"]);
  } finally { spool.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test("a large orphan backlog drains in bounded frames without another harness session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-backlog-"));
  const store = new WorkspanStore(join(dir, "db.sqlite"));
  const daemon = await startDaemon({ store, runtimeDir: join(dir, "run"), idleGapMs: 900_000 });
  try {
    writeFileSync(join(dir, "claude-spool-9000001.jsonl"), Array.from({ length: 1000 }, (_, i) => JSON.stringify(event(i))).join("\n") + "\n");
    const results = await Promise.all([drainOrphanedSpools({ directory: dir, socketPath: daemon.socketPath }), drainOrphanedSpools({ directory: dir, socketPath: daemon.socketPath })]);
    expect(store.observations()).toHaveLength(1000);
    expect(store.conflictRows()).toHaveLength(0);
    expect(results.reduce((a, b) => a + b, 0)).toBe(1000);
  } finally { await daemon.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a replayed identity with different metadata is recorded for review instead of pinning the spool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-conflict-"));
  const store = new WorkspanStore(join(dir, "db.sqlite"));
  const daemon = await startDaemon({ store, runtimeDir: join(dir, "run"), idleGapMs: 900_000 });
  try {
    // The same identity twice with different metadata: the first is accepted, the
    // second can never be. It must not keep the queue pinned and retrying forever.
    const first = event(1);
    const rows = [first, { ...first, at: first.at + 1 }, event(2)];
    const spoolPath = join(dir, "pi-spool-9000003.jsonl");
    writeFileSync(spoolPath, rows.map(row => JSON.stringify(row)).join("\n") + "\n");

    const delivered = await drainOrphanedSpools({ directory: dir, socketPath: daemon.socketPath });
    expect(delivered).toBe(3);
    expect(store.observations()).toHaveLength(2);
    expect(store.conflictRows()).toHaveLength(1);
    expect(existsSync(spoolPath)).toBe(false);
    expect(existsSync(spoolPath + ".error")).toBe(false);

    // The review debt stays visible where it can be acted on: status, doctor, report.
    expect(daemon.status().coverage.conflicts).toBe(1);
    const check = (await runDoctor({ runtimeDir: join(dir, "run"), databasePath: join(dir, "db.sqlite") })).checks.find(candidate => candidate.name === "evidence conflicts");
    expect(check?.state).toBe("attention");
  } finally { await daemon.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a killed producer leaves a recoverable snapshot after the daemon committed but before acknowledgement", async () => {
  const { validateEvent } = await import("../src/daemon/evidence.ts");
  const dir = mkdtempSync(join(tmpdir(), "ws-crash-delivery-"));
  const store = new WorkspanStore(join(dir, "db.sqlite"));
  const socketPath = join(dir, "mock.sock");
  let accepted!: () => void;
  const committed = new Promise<void>(resolve => { accepted = resolve; });
  const server = createServer(socket => socket.once("data", chunk => {
    const req = JSON.parse(chunk.toString());
    for (const raw of req.params.events) store.ingest(validateEvent(raw));
    accepted(); // Deliberately do not acknowledge.
  }));
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  const code = `import { EvidenceSpool } from ${JSON.stringify(join(import.meta.dir, "../src/client.ts"))}; const spool = new EvidenceSpool({spoolPath: ${JSON.stringify(dir)} + '/pi-spool-' + process.pid + '.jsonl', socketPath:${JSON.stringify(socketPath)}}); spool.append(${JSON.stringify(event(7))}); await spool.flush();`;
  const child = Bun.spawn([process.execPath, "--eval", code], { stdout: "ignore", stderr: "ignore" });
  try {
    await committed;
    child.kill("SIGKILL"); await child.exited;
    await new Promise<void>(resolve => server.close(() => resolve()));
    const daemon = await startDaemon({ store, runtimeDir: join(dir, "run") });
    await daemon.close(); // waits for startup recovery, with no harness needed
    expect(daemon.status().coverage.events).toBe(1);
    expect(daemon.status().coverage.conflicts).toBe(0);
    expect(daemon.status().delivery?.pending_bytes).toBe(0);
  } finally { child.kill(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("write/refusal health contains only coarse metadata and malformed evidence remains recoverable", async () => {
  const { spoolProblems } = await import("../src/client.ts");
  const dir = mkdtempSync(join(tmpdir(), "ws-refusal-"));
  const store = new WorkspanStore(join(dir, "db.sqlite"));
  const daemon = await startDaemon({ store, runtimeDir: join(dir, "run") });
  const notices: string[] = [];
  const spool = new EvidenceSpool({ spoolPath: join(dir, `pi-spool-${process.pid}.jsonl`), socketPath: daemon.socketPath, onFull: message => notices.push(message) });
  try {
    writeFileSync(spool.path, 'SYNTHETIC_SECRET_DO_NOT_LOG\n');
    await expect(spool.flush()).rejects.toThrow("spool_invalid");
    expect(spool.lines()).toEqual(["SYNTHETIC_SECRET_DO_NOT_LOG"]);
    expect(JSON.stringify(spoolProblems(dir)) + notices.join(" ")).not.toContain("SYNTHETIC_SECRET_DO_NOT_LOG");
    const tiny = new EvidenceSpool({ spoolPath: join(dir, `claude-spool-${process.pid}.jsonl`), socketPath: daemon.socketPath, maxBytes: 1, onFull: message => notices.push(message) });
    expect(tiny.append(event(1))).toBe(false);
    tiny.dispose();
    expect(spoolProblems(dir).some(problem => problem.code === "evidence_spool_full")).toBe(true);
  } finally { spool.dispose(); await daemon.close(); rmSync(dir, { recursive: true, force: true }); }
});
