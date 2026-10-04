import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspanStore } from "../src/daemon/db.ts";
import { startDaemon, type Daemon } from "../src/daemon/server.ts";
import { buildReport, formatReport, reportRows, type ReportFacts } from "../src/daemon/report.ts";
import { readReport, WorkspanClient } from "../src/client.ts";
import { createMcpServer } from "../src/mcp.ts";
import { trackerDayMs } from "../scripts/reconcile-tracker.ts";
import { dayBounds } from "../src/daemon/calendar.ts";
import type { ReportPage } from "../src/protocol.ts";

const t = Date.parse("2026-10-03T10:00:00Z");
const manual = (kind: "session-start" | "session-stop" | "session-pause" | "session-resume", at: number, session = "s", project = "client") => ({ source: "manual" as const, instance: "fixture", session, event: `${kind}-${at}`, kind, at, origin: "attested" as const, project });
function fixture() { const dir = mkdtempSync(join(tmpdir(), "ws-report-")); return { dir, store: new WorkspanStore(join(dir, "db.sqlite")) }; }

test("week is local Monday-Sunday with independent Bend totals and exact export rows", () => {
  const { dir, store } = fixture();
  try {
    const from = Date.parse("2026-10-02T23:59:59.123Z");
    store.ingest(manual("session-start", from), from);
    store.ingest(manual("session-stop", from + 120_987), from);
    const facts = buildReport(store, { period: "week", date: "2026-10-04", timezone: "UTC", now: t });
    expect(facts.date).toBe("2026-09-28");
    expect(facts.days.map(day => day.date)).toEqual(["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
    expect(facts.measures.attested.union_ms).toBe(120_987);
    expect(facts.days[4].measures.attested.union_ms).toBe(877);
    expect(facts.days[5].measures.attested.union_ms).toBe(120_110);
    expect(facts.measures.inferred.union_ms).toBe(0);
    expect(facts.measures.agent.union_ms).toBe(0);
    expect(JSON.parse(formatReport(facts, "json")).measures.attested.union_ms).toBe(120_987);
    const row = reportRows(facts).find(row => row[0] === "week" && row[5] === "attested" && row[6] === "union");
    expect(row?.[8]).toBe(120_987);
    expect(formatReport(facts, "csv")).toContain('"120987"');
    expect(formatReport(facts, "md")).toContain("120987");
    expect(facts.engine.digest).not.toBeNull();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("an open paused session exports provisional spans, not finalized hours", () => {
  const { dir, store } = fixture();
  try {
    store.ingest(manual("session-start", t), t);
    store.ingest(manual("session-pause", t + 600_000), t);
    const facts = buildReport(store, { date: "2026-10-03", timezone: "UTC", now: t + 1_800_000 });
    expect(facts.measures.attested.union_ms).toBe(0);
    expect(facts.days[0].sessions[0]).toMatchObject({ provisional_ms: 600_000, worked_ms: 0, state: "paused" });
    expect(formatReport(facts, "text")).toContain("provisional 10m (paused)");
    expect(formatReport(facts, "csv")).toContain('"provisional_session"');
    expect(formatReport(facts, "md")).toContain("provisional");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("export context escaping protects CSV cells and Markdown tables", () => {
  const { dir, store } = fixture();
  try {
    store.ingest(manual("session-start", t, "s", '=SUM(1,2)|<img>"'), t);
    store.ingest(manual("session-stop", t + 12_345, "s"), t);
    const facts = buildReport(store, { date: "2026-10-03", timezone: "UTC", now: t + 12_345 });
    expect(formatReport(facts, "csv")).toContain('"\'=SUM(1,2)|<img>"""');
    expect(formatReport(facts, "md")).toContain("=SUM(1,2)&#124;&lt;img&gt;");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("reconciliation clips crossing windows and retains millisecond precision", () => {
  const bounds = dayBounds("2026-10-03", "UTC");
  expect(trackerDayMs([{ kind: "work", start: bounds.start - 1000, end: bounds.start + 877 }, { kind: "work", start: bounds.end - 1000, end: bounds.end + 999 }, { kind: "gap", start: bounds.start, end: bounds.end }], bounds)).toBe(1877);
});

test("large report pages stay on one watermark across ledger changes; CLI and MCP use them", async () => {
  const { dir, store } = fixture();
  // Setup lives inside the try so a failure here still closes the store and removes
  // the temp directory instead of leaking both.
  let daemon: Daemon | null = null;
  try {
    for (let i = 0; i < 140; i++) {
      store.ingest(manual("session-start", t + i * 60_000, `s-${i}`), t);
      store.ingest(manual("session-stop", t + i * 60_000 + 1000, `s-${i}`), t);
      // Look the row up by identity: the note must not depend on row ordering.
      const session = store.sessionRows().find(row => row.session === `s-${i}`);
      if (!session) throw new Error(`no session row for s-${i}`);
      store.addSessionNote(session.id, "user-authored ".repeat(12), t);
    }
    daemon = await startDaemon({ store, runtimeDir: join(dir, "run"), now: () => t + 10_000_000 });
    const client = new WorkspanClient({ socketPath: daemon.socketPath });
    const query = { period: "day" as const, date: "2026-10-03", timezone: "UTC", format: "json" as const };
    const first = await client.request("report", query) as ReportPage;
    expect(first.next).not.toBeNull();
    const revision = store.revision();
    await client.bind("/later", "later");
    let text = first.chunk, page = first, pages = 0;
    while (page.next !== null) {
      // A cursor that never terminates must fail here with a clear message, not spin
      // until the runner timeout.
      if (++pages > 100) throw new Error(`report pagination did not terminate after ${pages} pages`);
      page = await client.request("report", { token: first.token, offset: page.next }) as ReportPage;
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(64_000);
      text += page.chunk;
    }
    expect(text.length).toBeGreaterThan(65_536);
    const captured = JSON.parse(text) as ReportFacts;
    expect(captured.revision).toBe(revision);
    expect(captured.days[0].sessions).toHaveLength(140);
    const fresh = JSON.parse(await client.report(query)) as ReportFacts;
    expect(fresh.revision).toBe(store.revision());
    expect(fresh.measures.attested.union_ms).toBe(140_000);
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/workspan.ts"), "--socket", daemon.socketPath, "week", "--date", "2026-10-03", "--tz", "UTC", "--export", "csv"], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(await proc.exited).toBe(0); expect(stderr).toBe(""); expect(stdout).toContain('"week","2026-09-28"');
    const mcp = createMcpServer((method, params) => client.request(method, params));
    const result = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "work_report", arguments: query } }) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(result.result.content[0].text).measures.attested.union_ms).toBe(140_000);
    await expect(client.request("report", { token: first.token, offset: -1 })).rejects.toThrow("bad_request");
    await expect(client.request("report", { token: "missing", offset: 0 })).rejects.toThrow("report_expired");
    expect(await readReport(query, (method, params) => client.request(method, params))).toContain('"schema": 1');
  } finally { if (daemon) await daemon.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("backup CLI requests the daemon snapshot and leaves later accepted evidence intact", async () => {
  const { dir, store } = fixture();
  let daemon: Daemon | null = null;
  try {
    store.ingest(manual("session-start", t), t);
    store.ingest(manual("session-stop", t + 1234), t);
    // A local binding, so the closure below cannot see a null daemon.
    const live = await startDaemon({ store, runtimeDir: join(dir, "run"), now: () => t + 3000 });
    daemon = live;
    const cli = async (...args: string[]) => {
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/workspan.ts"), "--socket", live.socketPath, ...args], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { code: await proc.exited, stdout, stderr };
    };
    const result = await cli("backup", "--keep", "2");
    expect(result.code).toBe(0); expect(result.stderr).toBe("");
    const backup = JSON.parse(result.stdout) as { path: string; identities: number; revision: number };
    expect(backup.identities).toBe(2); expect(backup.revision).toBe(store.revision());
    const target = join(dir, "restored.sqlite"); copyFileSync(backup.path, target);
    const restored = new WorkspanStore(target);
    try { expect(buildReport(restored, { date: "2026-10-03", timezone: "UTC" }).measures.attested.union_ms).toBe(1234); }
    finally { restored.close(); }
    const client = new WorkspanClient({ socketPath: live.socketPath });
    await client.ingest([{ v: 1, source: "desktop", instance: "fixture", session: "s", event: "later", kind: "interaction", at: t + 2000, origin: "unknown" }]);
    expect(store.observations()).toHaveLength(3);
    const bad = await cli("backup", "--keep", "0"); expect(bad.code).not.toBe(0);
  } finally { if (daemon) await daemon.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
