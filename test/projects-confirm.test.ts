import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspanStore } from "../src/daemon/db.ts";
import { startDaemon, type Daemon } from "../src/daemon/server.ts";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

let daemon: Daemon | null = null;
let runtimeDir = "";

test("a derived binding is confirmed without retyping the client, and stays reversible", async () => {
  const root = mkdtempSync(join(tmpdir(), "workspan-confirm-"));
  roots.push(root);
  runtimeDir = join(root, "run");
  daemon = await startDaemon({ store: new WorkspanStore(join(root, "workspan.sqlite")), runtimeDir, idleGapMs: 900_000 });
  const cli = async (...args: string[]) => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/workspan.ts"), "--socket", join(runtimeDir, "workspan.sock"), ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, stdout, stderr };
  };

  const derived = await cli("projects", "bind", "/home/u/repo", "derived-name");
  expect(derived.code).toBe(0);
  const before = JSON.parse((await cli("projects", "--json")).stdout) as Array<{ root: string; project: string; explicit: boolean }>;
  expect(before.find(row => row.root === "/home/u/repo")).toMatchObject({ project: "derived-name", explicit: false });

  // The label is carried over: confirming is a correction of the flag, not a new claim.
  const confirmed = await cli("projects", "confirm", "/home/u/repo");
  expect(confirmed.stderr).toBe("");
  expect(confirmed.code).toBe(0);
  const after = JSON.parse((await cli("projects", "--json")).stdout) as Array<{ root: string; project: string; explicit: boolean }>;
  expect(after.find(row => row.root === "/home/u/repo")).toMatchObject({ project: "derived-name", explicit: true });

  // Naming a root nobody named yet is an error that says what to do, not a guess.
  const unknown = await cli("projects", "confirm", "/home/u/nothing");
  expect(unknown.code).not.toBe(0);
  expect(unknown.stderr).toContain("no binding for /home/u/nothing");

  await daemon.close();
});
