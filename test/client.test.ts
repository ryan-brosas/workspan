import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceSpool, WorkspanClient, drainOrphanedSpools } from "../src/client.ts";
import { WorkspanStore } from "../src/daemon/db.ts";
import { startDaemon, type Daemon } from "../src/daemon/server.ts";

const root = mkdtempSync(join(tmpdir(), "workspan-client-"));
const runtimeDir = join(root, "run");
const socketPath = join(runtimeDir, "workspan.sock");
const store = new WorkspanStore(join(root, "workspan.sqlite"));
let daemon: Daemon | null = null;

const ensureDaemon = async (): Promise<Daemon> => (daemon ??= await startDaemon({ store, runtimeDir, idleGapMs: 900_000 }));
const event = (id: string, at: number) => ({ v: 1, source: "desktop", instance: "test", session: "test", event: `focus:${id}`, kind: "interaction", at, origin: "unknown" });

afterAll(async () => { if (daemon) await daemon.close(); store.close(); rmSync(root, { recursive: true, force: true }); });

test("the client speaks the protocol, and a refusal arrives as its code", async () => {
  await ensureDaemon();
  const client = new WorkspanClient({ socketPath });
  const health = await client.health() as { state: string; protocol: number };
  expect(health.state).toBe("ok");
  expect(health.protocol).toBe(1);
  await expect(client.request("session.note", { note: "x" })).rejects.toThrow(/^no_open_session/);
  await expect(new WorkspanClient({ socketPath: join(root, "absent.sock") }).health()).rejects.toThrow(/cannot reach the Workspan daemon/);
});

test("the spool holds evidence until the daemon accepts it, then clears", async () => {
  await ensureDaemon();
  const spool = new EvidenceSpool({ spoolPath: join(root, "spool.jsonl"), socketPath });
  spool.append(event("a", 1_700_000_000_000));
  spool.append(event("b", 1_700_000_001_000));
  expect(spool.pendingBytes).toBeGreaterThan(0);
  expect(await spool.flush()).toBe(2);

  const client = new WorkspanClient({ socketPath });
  const status = await client.status() as { coverage: { sources: Array<{ source: string; events: number }> } };
  expect(status.coverage.sources.find(source => source.source === "desktop")?.events).toBe(2);
  expect(spool.pendingBytes).toBe(0);

  // The same line again is a duplicate with an identical fingerprint, never a conflict.
  spool.append(event("a", 1_700_000_000_000));
  expect(await spool.flush()).toBe(1);
  expect((await client.status() as { watermark: { conflicts: number } }).watermark.conflicts).toBe(0);
});

test("an undeliverable spool is kept, and a full one refuses loudly once", async () => {
  await ensureDaemon();
  const down = new EvidenceSpool({ spoolPath: join(root, "down.jsonl"), socketPath: join(root, "absent.sock") });
  down.append(event("c", 1_700_000_002_000));
  await expect(down.flush()).rejects.toThrow(/cannot reach/);
  expect(down.pendingBytes).toBeGreaterThan(0);

  const notices: string[] = [];
  const tiny = new EvidenceSpool({ spoolPath: join(root, "tiny.jsonl"), socketPath, maxBytes: Buffer.byteLength(JSON.stringify(event("d", 1)) + "\n"), onFull: message => notices.push(message) });
  expect(tiny.append(event("d", 1))).toBe(true);
  expect(tiny.append(event("e", 2))).toBe(false);
  expect(tiny.append(event("f", 3))).toBe(false);
  expect(notices.length).toBe(1);
  expect(notices[0]).toContain("spool is full");
});

test("evidence stranded by a dead process is drained, and a live process's spool is left alone", async () => {
  await ensureDaemon();
  const directory = join(root, "orphans");
  mkdirSync(directory, { recursive: true });
  const orphan = join(directory, "pi-spool-999999.jsonl");
  writeFileSync(orphan, JSON.stringify(event("orphan", 1_700_000_003_000)) + "\n");
  expect(await drainOrphanedSpools({ socketPath, directory, prefix: "pi-spool-" })).toBe(1);
  expect(existsSync(orphan)).toBe(false);

  const mine = join(directory, `pi-spool-${process.pid}.jsonl`);
  writeFileSync(mine, JSON.stringify(event("mine", 1_700_000_004_000)) + "\n");
  expect(await drainOrphanedSpools({ socketPath, directory, prefix: "pi-spool-" })).toBe(0);
  expect(readFileSync(mine, "utf8")).toContain("mine");
});
