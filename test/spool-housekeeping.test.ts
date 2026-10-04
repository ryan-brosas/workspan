import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceSpool, drainOrphanedSpools, listSpools } from "../src/client.ts";

/** A pid above pid_max: the kernel answers ESRCH, so "the writer is gone" is deterministic. */
const deadPid = (offset: number): number => 9_000_000 + offset;

function directory(): string { return mkdtempSync(join(tmpdir(), "workspan-spool-")); }

test("an empty spool is litter and is removed; undelivered evidence never is", () => {
  const dir = directory();
  try {
    const spool = new EvidenceSpool({ spoolPath: join(dir, "pi-spool-4242.jsonl") });
    expect(existsSync(spool.path)).toBe(true);
    spool.dispose();
    expect(existsSync(spool.path)).toBe(false);

    spool.append({ v: 1, source: "pi", instance: "fixture", session: "s", event: "e", kind: "interaction", at: 1, origin: "human" });
    spool.dispose();
    expect(existsSync(spool.path)).toBe(true);
    expect(spool.lines().length).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the inventory uses the shared naming, and orphan spools are cleaned or kept", async () => {
  const dir = directory();
  try {
    writeFileSync(join(dir, `claude-spool-${deadPid(1)}.jsonl`), "");
    writeFileSync(join(dir, `opencode-spool-${deadPid(2)}.jsonl`), "");
    writeFileSync(join(dir, "notes.txt"), "keep me");
    const empty = listSpools({ directory: dir });
    expect(empty.map(file => file.name)).toEqual([`claude-spool-${deadPid(1)}.jsonl`, `opencode-spool-${deadPid(2)}.jsonl`]);
    expect(empty.every(file => file.bytes === 0 && !file.alive)).toBe(true);

    // No daemon to deliver to: the empty orphans are still removed, and a file that
    // holds evidence is kept for the next attempt.
    writeFileSync(join(dir, `pi-spool-${deadPid(3)}.jsonl`), '{"v":1}\n');
    expect(await drainOrphanedSpools({ directory: dir, socketPath: join(dir, "nothing.sock") })).toBe(0);
    expect(existsSync(join(dir, `claude-spool-${deadPid(1)}.jsonl`))).toBe(false);
    expect(existsSync(join(dir, `opencode-spool-${deadPid(2)}.jsonl`))).toBe(false);
    expect(existsSync(join(dir, `pi-spool-${deadPid(3)}.jsonl.pending`))).toBe(true);
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
