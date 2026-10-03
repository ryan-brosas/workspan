import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OPENCODE_QUERY, opencodeProbe, readOpencode } from "../src/adapters/opencode.ts";
import { collectHarness, harnessReaders } from "../src/adapters/registry.ts";
import { WorkspanStore } from "../src/daemon/db.ts";
import { validateEvent } from "../src/daemon/evidence.ts";
import { buildStatus } from "../src/daemon/measures.ts";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const SECRET = "SECRET_OPENCODE_MESSAGE_BODY";
const T = 1_700_000_000_000;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "opencode-fixture-"));
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const plain = join(root, "plain");
  mkdirSync(plain, { recursive: true });
  const dbPath = join(root, "opencode.db");
  const now = T + 10 * 3600_000;
  const db = new DatabaseSync(dbPath);
  db.exec("create table session (id text primary key, directory text); create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text);");
  const session = db.prepare("insert into session(id, directory) values(?,?)");
  const message = db.prepare("insert into message(id, session_id, time_created, time_updated, data) values(?,?,?,?,?)");
  session.run("ses-1", repo);
  session.run("ses-2", plain);
  session.run("ses-3", plain);
  message.run("m1", "ses-1", T, T + 60_000, JSON.stringify({ text: SECRET }));
  message.run("m2", "ses-1", T + 3 * 60_000, T + 4 * 60_000, JSON.stringify({ text: SECRET }));
  message.run("m3", "ses-1", T + 30 * 60_000, T + 31 * 60_000, null);
  message.run("m4", "ses-2", T + 2 * 3600_000, T + 2 * 3600_000 + 30_000, null);
  message.run("m5", "ses-3", now - 60_000, now - 30_000, null);
  db.close();
  return { dbPath, repo, plain, now };
}

test("messages pair into blocks per session, and only settled blocks end", () => {
  const { dbPath, repo, plain, now } = fixture();
  const { events, summary } = readOpencode({ store: dbPath, sinceMs: 0, now });
  expect(events.map(event => [event.session, event.kind, event.at])).toEqual([
    ["ses-1", "agent-start", T],
    ["ses-1", "agent-end", T + 4 * 60_000],
    ["ses-1", "agent-start", T + 30 * 60_000],
    ["ses-1", "agent-end", T + 31 * 60_000],
    ["ses-2", "agent-start", T + 2 * 3600_000],
    ["ses-2", "agent-end", T + 2 * 3600_000 + 30_000],
    ["ses-3", "agent-start", now - 60_000],
  ]);
  expect(summary.blocks).toBe(4);
  expect(summary.open).toBe(1);
  expect(summary.lastEventAt).toBe(now - 30_000);
  expect(summary.staleDays).toBe(0);
  expect(events.find(event => event.session === "ses-1")?.root).toBe(repo);
  expect(events.find(event => event.session === "ses-2")?.root).toBe(plain);
  expect(events.every(event => event.origin === "automated" && event.source === "opencode")).toBe(true);
});

test("no message body is ever selected or emitted", () => {
  const { dbPath, now } = fixture();
  expect(OPENCODE_QUERY).not.toContain("data");
  const { events, summary } = readOpencode({ store: dbPath, sinceMs: 0, now });
  expect(JSON.stringify({ events, summary })).not.toContain(SECRET);
});

test("a store that is not there is unavailable, never zero", () => {
  const { dbPath } = fixture();
  const missing = join(dbPath, "..", "missing.db");
  const { events, summary } = readOpencode({ store: missing, sinceMs: 0 });
  expect(events).toEqual([]);
  expect(summary.store).toBeNull();
  expect(summary.lastEventAt).toBeNull();
  expect(summary.staleDays).toBeNull();
  expect(opencodeProbe({ store: missing }).store).toBeNull();
});

test("importing twice adds nothing, and the open turn stays visible", () => {
  const { dbPath, now } = fixture();
  const { events } = readOpencode({ store: dbPath, sinceMs: 0, now });
  const root = mkdtempSync(join(tmpdir(), "workspan-opencode-"));
  roots.push(root);
  const store = new WorkspanStore(join(root, "workspan.sqlite"));
  for (const event of events) store.ingest(validateEvent(event), 1);
  const status = buildStatus(store, { idleGapMs: 900_000, now });
  expect(status.measures.agent.union_ms).toBe(330_000);
  expect(status.measures.agent.unallocated_ms).toBe(330_000);
  expect(status.coverage.open_agent_turns).toBe(1);
  expect(status.measures.attested.union_ms).toBe(0);
  expect(status.measures.inferred.union_ms).toBe(0);
  for (const event of events) store.ingest(validateEvent(event), 2);
  const again = buildStatus(store, { idleGapMs: 900_000, now });
  expect(again.measures.agent.union_ms).toBe(330_000);
  expect(again.coverage.conflicts).toBe(0);
  store.close();
});

test("the registry reads the same blocks through one contract", () => {
  const { dbPath, now } = fixture();
  expect(harnessReaders().map(reader => reader.id)).toEqual(["codex", "opencode", "claude"]);
  const collected = collectHarness({ id: "opencode", store: dbPath, sinceMs: 0, now });
  expect(collected).toHaveLength(1);
  expect(collected[0].events).toHaveLength(7);
});
