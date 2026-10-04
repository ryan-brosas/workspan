import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspanClient } from "../src/client.ts";
import { WorkspanStore } from "../src/daemon/db.ts";
import type { Status } from "../src/daemon/measures.ts";
import { startDaemon, type Daemon } from "../src/daemon/server.ts";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const base = 1_700_000_000_000;
const MINUTE = 60_000;

/** Pi presence: human origin and a workspace root, which is what the clock reads. */
const tick = (at: number, cwd: string, id: string) => ({ v: 1, source: "pi", instance: "laptop", session: "s1", event: id, kind: "interaction", at, origin: "human", root: cwd });

/**
 * It runs through the daemon on purpose: the clock that turns presence into windows
 * lives in the server, so a store-level test would prove nothing about a live lane.
 */
test("unallocated inferred time names its root, and a named root is attributed", async () => {
  const root = mkdtempSync(join(tmpdir(), "workspan-unallocated-"));
  roots.push(root);
  const runtimeDir = join(root, "run");
  const store = new WorkspanStore(join(root, "workspan.sqlite"));
  // Named before the evidence arrives: attribution resolves from bindings, and a
  // binding made later does not relabel history (that stays the migration's open item).
  store.bindProject("/home/u/coral", "coral", true, "cli");
  const daemon: Daemon = await startDaemon({ store, runtimeDir, idleGapMs: 900_000 });
  try {
    const client = new WorkspanClient({ socketPath: join(runtimeDir, "workspan.sock") });
    await client.ingest([
      tick(base, "/home/u/coral", "a1"),
      tick(base + MINUTE, "/home/u/coral", "a2"),
      tick(base + 3 * MINUTE, "/home/u/unnamed", "b1"),
      tick(base + 4 * MINUTE, "/home/u/unnamed", "b2"),
    ]);
    const status = (await client.status()) as Status;
    const inferred = status.measures.inferred;

    expect(inferred.projects.map(row => row.project)).toContain("coral");
    expect(inferred.unallocated_roots.map(row => row.root)).toEqual(["/home/u/unnamed"]);
    expect(inferred.unallocated_roots[0]!.ms).toBeGreaterThan(0);
    // A part is a union of its own root's intervals, so it can never exceed the measure.
    expect(inferred.unallocated_roots[0]!.ms).toBeLessThanOrEqual(inferred.unallocated_ms);
    expect(inferred.unallocated_roots.some(row => row.root === "/home/u/coral")).toBe(false);
  } finally { await daemon.close(); }
});
