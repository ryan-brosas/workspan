import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspanStore } from "../src/daemon/db.ts";
import { buildReport } from "../src/daemon/report.ts";
import { SNAPSHOT_CAPACITY, SNAPSHOT_TTL_MS, createReportPager } from "../src/daemon/report-pages.ts";
import { startDaemon, type Daemon } from "../src/daemon/server.ts";
import { WorkspanClient } from "../src/client.ts";

test("report continuations never rebuild facts and snapshots expire or evict explicitly", () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-report-pages-")), store = new WorkspanStore(join(dir, "db.sqlite"));
  let now = 0, builds = 0;
  const pager = createReportPager(query => { builds++; return buildReport(store, { ...query, now: 1_791_000_000_000 }); }, () => now);
  const query = { period: "day", date: "2026-10-03", timezone: "UTC", format: "json" };
  try {
    const first = pager(query);
    store.bindProject("/later", "later", true, "test");
    expect(pager({ token: first.token, offset: 0 }).chunk).toBe(first.chunk);
    expect(builds).toBe(1);
    // The lifetime the pager documents, not a literal repeated beside it.
    now = SNAPSHOT_TTL_MS;
    expect(() => pager({ token: first.token, offset: 0 })).toThrow("expired");
    const rebuilt = pager(query);
    // Expiry must rebuild: handing the stale snapshot back would reuse its token.
    expect(rebuilt.token).not.toBe(first.token);
    expect(builds).toBe(2);
    const survivor = pager(query);
    for (let i = 0; i < SNAPSHOT_CAPACITY; i++) pager(query);
    expect(() => pager({ token: survivor.token, offset: 0 })).toThrow("expired");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("invalid calendar input and backup keep bounds are bad requests", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-calendar-input-")), store = new WorkspanStore(join(dir, "db.sqlite"));
  let daemon: Daemon | null = null;
  try {
    daemon = await startDaemon({ store, runtimeDir: join(dir, "run") });
    const client = new WorkspanClient({ socketPath: daemon.socketPath });
    await expect(client.request("report", { period: "day", timezone: "not-a-zone" })).rejects.toThrow("bad_request");
    await expect(client.request("report", { period: "day", date: "2026-02-30", timezone: "UTC" })).rejects.toThrow("bad_request");
    await expect(client.request("day", { timezone: "not-a-zone" })).rejects.toThrow("bad_request");
    await expect(client.request("backup", { keep: 0 })).rejects.toThrow("bad_request");
    await expect(client.request("backup", { keep: 366 })).rejects.toThrow("bad_request");
  } finally { if (daemon) await daemon.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
