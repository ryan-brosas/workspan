import { afterAll, expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectCodexEvents, defaultCodexHistoryPath, discoverCodexHistoryPath, readCodexTurns, TURN_QUERY, toEvidence } from "../src/adapters/codex.ts";
import { WorkspanStore } from "../src/daemon/db.ts";
import { validateEvent } from "../src/daemon/evidence.ts";
import { buildStatus } from "../src/daemon/measures.ts";

const roots: string[] = [];
const SECRET = "SECRET_PROMPT_TEXT_should_never_be_read";

/** The installed schema's timing columns, plus the payload columns we must not read. */
function fixtureCodex(since: number) {
  const root = mkdtempSync(join(tmpdir(), "codex-fixture-"));
  roots.push(root);
  const path = join(root, "thread_history_1.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`create table thread_turns (
    thread_id text not null, turn_id text not null, rollout_ordinal integer not null, status text not null,
    error_json text, started_at integer, completed_at integer, duration_ms integer,
    first_user_item_id text, final_agent_item_id text,
    primary key (thread_id, turn_id))`);
  const insert = db.prepare("insert into thread_turns(thread_id, turn_id, rollout_ordinal, status, error_json, started_at, completed_at, duration_ms) values(?,?,?,?,?,?,?,?)");
  const sec = (ms: number) => Math.floor(ms / 1000);
  insert.run("thread-a", "turn-1", 1, "completed", SECRET, sec(since + 60_000), sec(since + 660_000), 600_000);
  insert.run("thread-a", "turn-2", 2, "in_progress", null, sec(since + 900_000), null, null);
  insert.run("thread-b", "turn-3", 1, "completed", null, sec(since + 1_200_000), sec(since + 1_100_000), 100);
  insert.run("thread-b", "turn-4", 2, "completed", null, null, sec(since + 1_500_000), 100);
  insert.run("thread-c", "turn-5", 1, "completed", null, sec(since - 600_000), sec(since - 540_000), 60_000);
  db.close();
  return path;
}

test("only the timing columns are ever selected", () => {
  expect(TURN_QUERY).toContain("thread_id, turn_id, started_at, completed_at");
  for (const forbidden of ["error_json", "item", "rollout", "status", "duration_ms"]) expect(TURN_QUERY).not.toContain(forbidden);
});

test("turn timing becomes agent-runtime evidence with no human claim and no project", () => {
  const since = 1_700_000_000_000;
  const path = fixtureCodex(since);
  const { events, summary } = collectCodexEvents({ dbPath: path, sinceMs: since });

  // turn-1 closed, turn-2 open, turn-3 ends before it starts, turn-4 has no start, turn-5 is outside the window
  expect(summary.turns).toBe(4);
  expect(summary.anomalies).toBe(1);
  expect(summary.endsWithoutStart).toBe(1);
  expect(events.map(e => [e.session, e.event, e.kind, e.origin, e.at - since])).toEqual([
    ["thread-a", "turn-1:start", "agent-start", "automated", 60_000],
    ["thread-a", "turn-1:end", "agent-end", "automated", 660_000],
    ["thread-a", "turn-2:start", "agent-start", "automated", 900_000],
    ["thread-b", "turn-3:start", "agent-start", "automated", 1_200_000],
  ]);
  for (const event of events) {
    expect(event.project).toBeUndefined();
    expect(event.source).toBe("codex");
    expect(validateEvent(event)).toEqual(event);
  }
  // Bounds describe the evidence actually emitted, not the raw rows: turn-4 has no
  // start and contributes neither a duration nor a bound.
  expect(summary.from).toBe(since + 60_000);
  expect(summary.to).toBe(since + 1_200_000);
});

test("no conversation content is read, even when it sits in the same rows", () => {
  const since = 1_700_000_000_000;
  const path = fixtureCodex(since);
  const { events, summary } = collectCodexEvents({ dbPath: path, sinceMs: since });
  const serialized = JSON.stringify({ events, summary });
  expect(serialized).not.toContain(SECRET);
  expect(serialized).not.toContain("SECRET");
  for (const event of events) expect(Object.keys(event).sort()).toEqual(["at", "event", "instance", "kind", "origin", "session", "source"]);
});

test("the window is honoured and the default path follows CODEX_HOME", () => {
  const since = 1_700_000_000_000;
  const path = fixtureCodex(since);
  const narrow = readCodexTurns({ dbPath: path, sinceMs: since + 800_000 });
  expect(narrow.turns.map(t => t.turnId)).toEqual(["turn-2", "turn-3", "turn-4"]);
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = "/tmp/codex-home";
  try { expect(defaultCodexHistoryPath()).toBe("/tmp/codex-home/thread_history_1.sqlite"); }
  finally { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
});

test("the newest store that carries thread_turns answers, and freshness is reported", () => {
  const since = 1_700_000_000_000;
  const root = mkdtempSync(join(tmpdir(), "codex-discovery-"));
  roots.push(root);
  const sec = (ms: number) => Math.floor(ms / 1000);
  const makeStore = (name: string, run: (db: DatabaseSync) => void) => {
    const path = join(root, name);
    const db = new DatabaseSync(path);
    db.exec("create table thread_turns (thread_id text, turn_id text, started_at integer, completed_at integer)");
    run(db);
    db.close();
    return path;
  };

  const older = makeStore("thread_history_0.sqlite", db => db.prepare("insert into thread_turns values('t-old','u-1',?,?)").run(sec(since - 30 * 86_400_000), sec(since - 30 * 86_400_000) + 60));
  const newest = makeStore("thread_history_2.sqlite", db => db.prepare("insert into thread_turns values('t-new','u-1',?,?)").run(sec(since), sec(since) + 60));
  // A newer file that is not a thread history must not answer.
  const fake = join(root, "thread_history_9.sqlite");
  new DatabaseSync(fake).close();
  utimesSync(older, new Date(since - 30 * 86_400_000), new Date(since - 30 * 86_400_000));
  utimesSync(newest, new Date(since), new Date(since));
  utimesSync(fake, new Date(since + 60_000), new Date(since + 60_000));
  expect(discoverCodexHistoryPath(root)).toBe(newest);

  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
  try {
    const { turns, summary } = readCodexTurns({ sinceMs: since - 86_400_000, now: since + 3 * 86_400_000 + 60_000 });
    expect(turns.map(t => t.turnId)).toEqual(["u-1"]);
    expect(summary.store).toBe(newest);
    expect(summary.storeMtime).toBeGreaterThan(0);
    expect(summary.lastTurnAt).toBe(since + 60_000);
    expect(summary.staleDays).toBe(3);
  } finally { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
});

test("no store at all is unavailable, not zero", () => {
  const previous = process.env.CODEX_HOME;
  const empty = mkdtempSync(join(tmpdir(), "codex-empty-"));
  roots.push(empty);
  process.env.CODEX_HOME = empty;
  try {
    const { turns, summary } = readCodexTurns({ sinceMs: 0 });
    expect(turns).toEqual([]);
    expect(summary.store).toBeNull();
    expect(summary.lastTurnAt).toBeNull();
    expect(summary.staleDays).toBeNull();
  } finally { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
  expect(discoverCodexHistoryPath(join(empty, "missing"))).toBeNull();
});

test("an end without a start is not evidence of a duration", () => {
  expect(toEvidence([{ threadId: "t", turnId: "u", startedAtMs: null, completedAtMs: 5_000 }])).toEqual([]);
});

test("importing twice adds nothing, and an open turn stays visible as open", () => {
  const since = 1_700_000_000_000;
  const path = fixtureCodex(since);
  const root = mkdtempSync(join(tmpdir(), "workspan-codex-"));
  roots.push(root);
  const store = new WorkspanStore(join(root, "workspan.sqlite"));
  const { events } = collectCodexEvents({ dbPath: path, sinceMs: since });

  const first = events.map(event => store.ingest(validateEvent(event), 1).status);
  const second = events.map(event => store.ingest(validateEvent(event), 2).status);
  expect(first).toEqual(["accepted", "accepted", "accepted", "accepted"]);
  expect(second).toEqual(["duplicate", "duplicate", "duplicate", "duplicate"]);
  expect(store.observations()).toHaveLength(4);

  const status = buildStatus(store, { idleGapMs: 900_000 });
  // Only the closed turn has a duration; the open one is coverage, not time.
  expect(status.measures.agent.union_ms).toBe(600_000);
  expect(status.measures.agent.projects).toEqual([]);
  expect(status.measures.agent.unallocated_ms).toBe(600_000);
  // Two open turns: thread-a's in-progress turn, and thread-b's anomalous one,
  // whose completion was dropped. Neither claims a duration, so both stay visible.
  expect(status.coverage.open_agent_turns).toBe(2);
  expect(status.measures.inferred.union_ms).toBe(0);
  store.close();
});

afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
