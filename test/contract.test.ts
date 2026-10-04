import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspanClient } from "../src/client.ts";
import { METHODS } from "../src/protocol.ts";
import { WorkspanStore } from "../src/daemon/db.ts";
import { startDaemon, type Daemon } from "../src/daemon/server.ts";

const root = mkdtempSync(join(tmpdir(), "workspan-contract-"));
const runtimeDir = join(root, "run");
const store = new WorkspanStore(join(root, "workspan.sqlite"));
let daemon: Daemon | null = null;
const client = () => new WorkspanClient({ socketPath: join(runtimeDir, "workspan.sock") });

afterAll(async () => { if (daemon) await daemon.close(); store.close(); rmSync(root, { recursive: true, force: true }); });

test("every documented method is reachable, and none of them is unknown", async () => {
  daemon = await startDaemon({ store, runtimeDir, idleGapMs: 900_000 });
  const c = client();
  const failures: string[] = [];
  for (const method of METHODS) {
    try {
      await c.request(method, {});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A daemon-side refusal is fine; a missing method or a dead socket is not.
      if (!/^[a-z_]+: /.test(message) || message.startsWith("unknown_method") || message.includes("cannot reach")) failures.push(`${method}: ${message}`);
    }
  }
  expect(failures).toEqual([]);
});

test("the contract semantics a harness depends on: stable codes, idempotent commands, notes, day", async () => {
  const c = client();
  const started = await c.session("start", { project: "coral" }) as { session: string };
  await expect(c.session("start", { project: "coral" })).rejects.toThrow(/^session_open/);
  expect((await c.session("pause") as { state: string }).state).toBe("paused");
  expect((await c.session("resume") as { state: string }).state).toBe("running");
  expect((await c.note({ note: "contract check" }) as { note: { text: string } }).note.text).toBe("contract check");
  expect((await c.session("stop", { session: started.session }) as { session: string }).session).toBe(started.session);
  await expect(c.request("session.note", { note: "x", session: "nope" })).rejects.toThrow(/^no_such_session/);
  await expect(c.request("session.stop", { session: "nope" })).rejects.toThrow(/^no_such_session/);
  const status = await c.status() as { measures: { attested: { union_ms: number } }; non_additive: string; uncovered: { today_ms: number } };
  expect(status.non_additive).toContain("never added together");
  expect(status.uncovered.today_ms).toBeGreaterThanOrEqual(0);
  expect((await c.day() as { text: string }).text).toContain("contract check");
});
