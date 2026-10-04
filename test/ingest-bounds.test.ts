import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspanStore } from "../src/daemon/db.ts";
import { startDaemon, type Daemon } from "../src/daemon/server.ts";

const root = mkdtempSync(join(tmpdir(), "workspan-ingest-bounds-"));
const runtimeDir = join(root, "run");
const store = new WorkspanStore(join(root, "workspan.sqlite"));
let daemon: Daemon | null = null;
const base = 1_700_000_000_000;
const record = (id: string, at: number) => ({ v: 1, source: "desktop", instance: "test", session: "bounds", event: id, kind: "interaction", at, origin: "unknown" });

afterAll(async () => { if (daemon) await daemon.close(); store.close(); rmSync(root, { recursive: true, force: true }); });

async function cli(...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/workspan.ts"), "--socket", join(runtimeDir, "workspan.sock"), ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr };
}

test("one record too large for a frame is refused alone instead of aborting the import", async () => {
  daemon = await startDaemon({ store, runtimeDir, idleGapMs: 900_000 });
  const file = join(root, "mixed.jsonl");
  // A collector or a hand-written file can carry a record no frame can. It must cost
  // only itself: the spool cannot produce one, because validateEvent bounds every field.
  writeFileSync(file, [
    JSON.stringify({ ...record("big", base), project: "x".repeat(30_000) }),
    JSON.stringify(record("small", base + 1_000)),
  ].join("\n") + "\n");
  const result = await cli("ingest", "--file", file);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("event_too_large");
  expect(JSON.parse(result.stdout)).toMatchObject({ accepted: 1, refused_too_large: 1 });
  const status = JSON.parse((await cli("status")).stdout) as { coverage: { sources: Array<{ source: string; events: number }> } };
  expect(status.coverage.sources.find(source => source.source === "desktop")?.events).toBe(1);
});
