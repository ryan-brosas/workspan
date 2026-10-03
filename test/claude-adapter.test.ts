import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTurns, claudeProbe, readClaude, type TurnRecord } from "../src/adapters/claude.ts";
import { WorkspanStore } from "../src/daemon/db.ts";
import { validateEvent } from "../src/daemon/evidence.ts";
import { buildStatus } from "../src/daemon/measures.ts";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const SECRET = "SECRET_CLAUDE_MESSAGE_BODY";
const T = 1_700_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

function line(type: "user" | "assistant", at: number, cwd: string, session: string): string {
  return JSON.stringify({ type, timestamp: iso(at), cwd, sessionId: session, message: { role: type, content: SECRET } });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "claude-fixture-"));
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const plain = join(root, "plain");
  mkdirSync(plain, { recursive: true });
  const projects = join(root, "projects");
  const now = T + 6 * 3600_000;
  // One closed turn, then a trailing turn that has settled with age.
  const a = join(projects, "-tmp-repo");
  mkdirSync(a, { recursive: true });
  const aPath = join(a, "sess-a.jsonl");
  writeFileSync(aPath, [
    line("user", T, repo, "sess-a"),
    line("assistant", T + 60_000, repo, "sess-a"),
    line("user", T + 10 * 60_000, repo, "sess-a"),
    line("assistant", T + 10 * 60_000 + 30_000, repo, "sess-a"),
    line("assistant", T + 11 * 60_000, repo, "sess-a"),
  ].join("\n") + "\n");
  // A session still in flight: an open turn, no end claimed. Newest file, so it
  // also answers freshness.
  const b = join(projects, "-tmp-plain");
  mkdirSync(b, { recursive: true });
  const bPath = join(b, "sess-b.jsonl");
  writeFileSync(bPath, [
    line("user", now - 30_000, plain, "sess-b"),
    line("assistant", now - 20_000, plain, "sess-b"),
  ].join("\n") + "\n");
  // Filesystem timestamp resolution must not decide which transcript is newest:
  // the plain session is written last but gets an explicit later mtime.
  utimesSync(aPath, new Date(T + 11 * 60_000), new Date(T + 11 * 60_000));
  utimesSync(bPath, new Date(now), new Date(now));
  return { repo, plain, projects, now };
}

test("a turn is user-anchored and assistant-closed, and the last one stays open until settled", () => {
  const { repo, plain, projects, now } = fixture();
  const { events, summary } = readClaude({ store: projects, sinceMs: 0, now });
  expect(events.map(event => [event.session, event.kind, event.at])).toEqual([
    ["sess-a", "agent-start", T],
    ["sess-a", "agent-end", T + 60_000],
    ["sess-a", "agent-start", T + 10 * 60_000],
    ["sess-a", "agent-end", T + 11 * 60_000],
    ["sess-b", "agent-start", now - 30_000],
  ]);
  expect(summary.turns).toBe(3);
  expect(summary.open).toBe(1);
  expect(summary.lastEventAt).toBe(now - 20_000);
  expect(summary.staleDays).toBe(0);
  expect(events.find(event => event.session === "sess-a")?.root).toBe(repo);
  expect(events.find(event => event.session === "sess-b")?.root).toBe(plain);
  expect(events.every(event => event.origin === "automated" && event.source === "claude")).toBe(true);
});

test("no conversation content is read, even though every line carries it", () => {
  const { projects, now } = fixture();
  const { events, summary } = readClaude({ store: projects, sinceMs: 0, now });
  expect(JSON.stringify({ events, summary })).not.toContain(SECRET);
});

test("two user records with no answer between them are not a turn", () => {
  const rec = (at: number, type: "user" | "assistant"): TurnRecord => ({ at, type, cwd: null, session: null });
  expect(buildTurns([rec(0, "user"), rec(60_000, "user")], "s", 10_000_000)).toEqual([
    { session: "s", start: 60_000, end: null, settled: false, cwd: null },
  ]);
  // A truncated transcript does not guess a turn from a cut assistant record.
  expect(buildTurns([rec(0, "assistant"), rec(10, "user"), rec(20, "assistant")], "s", 10_000_000, true)).toEqual([
    { session: "s", start: 10, end: 20, settled: true, cwd: null },
  ]);
});

test("importing twice adds nothing, and the open turn stays visible", () => {
  const { projects, now } = fixture();
  const { events } = readClaude({ store: projects, sinceMs: 0, now });
  const root = mkdtempSync(join(tmpdir(), "workspan-claude-"));
  roots.push(root);
  const store = new WorkspanStore(join(root, "workspan.sqlite"));
  for (const event of events) store.ingest(validateEvent(event), 1);
  const status = buildStatus(store, { idleGapMs: 900_000, now });
  expect(status.measures.agent.union_ms).toBe(120_000);
  expect(status.coverage.open_agent_turns).toBe(1);
  expect(status.measures.attested.union_ms).toBe(0);
  expect(status.measures.inferred.union_ms).toBe(0);
  for (const event of events) store.ingest(validateEvent(event), 2);
  const again = buildStatus(store, { idleGapMs: 900_000, now });
  expect(again.measures.agent.union_ms).toBe(120_000);
  expect(again.coverage.conflicts).toBe(0);
  store.close();
});

test("a store that is not there is unavailable, never zero", () => {
  const { projects } = fixture();
  const missing = join(projects, "nope");
  const { events, summary } = readClaude({ store: missing, sinceMs: 0 });
  expect(events).toEqual([]);
  expect(summary.store).toBeNull();
  expect(summary.lastEventAt).toBeNull();
  expect(claudeProbe({ store: missing }).store).toBeNull();
});
