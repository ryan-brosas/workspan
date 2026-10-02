import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineInfo } from "../src/daemon/engine.ts";
import { WorkspanStore } from "../src/daemon/db.ts";
import { buildStatus, type StatusCache } from "../src/daemon/measures.ts";

const dir = mkdtempSync(join(tmpdir(), "workspan-projection-"));
const store = new WorkspanStore(join(dir, "workspan.sqlite"));
const cache: StatusCache = {};
const builds = () => cache.builds ?? 0;
const agentStart = (id: string, at: number) => ({ source: "pi" as const, instance: "i", session: "s", event: id, kind: "agent-start" as const, at, origin: "automated" as const });
const engine = (label: string): EngineInfo => ({ label, native: label !== "generated Bend policy", digest: "digest", bytes: 1, version: "2.0.31", sources: [], proofs: [], artifact: "/policy.mjs" });

test("an unchanged ledger reuses the projection and refreshes only the live fields", () => {
  const before = builds();
  const first = buildStatus(store, { idleGapMs: 900_000, now: 1_000, cache });
  expect(builds()).toBe(before + 1);
  const second = buildStatus(store, { idleGapMs: 900_000, now: 2_000, cache });
  // No recompute, but the timestamp is not cached with it.
  expect(builds()).toBe(before + 1);
  expect(second.measures).toEqual(first.measures);
  expect(first.generated_at).toBe(1_000);
  expect(second.generated_at).toBe(2_000);
});

test("accepted evidence invalidates the projection, and a replay does not", () => {
  const before = builds();
  store.ingest(agentStart("e1", 1_700_000_000_000), 1);
  buildStatus(store, { idleGapMs: 900_000, cache });
  expect(builds()).toBe(before + 1);

  const cached = builds();
  store.ingest(agentStart("e1", 1_700_000_000_000), 2); // duplicate: nothing changed
  buildStatus(store, { idleGapMs: 900_000, cache });
  expect(builds()).toBe(cached);
});

test("a recorded conflict invalidates it, because the report shows conflicts", () => {
  const before = builds();
  store.ingest({ ...agentStart("e1", 1_700_000_000_000), project: "other" }, 3);
  buildStatus(store, { idleGapMs: 900_000, cache });
  expect(builds()).toBe(before + 1);
});

test("the idle policy and the engine identity are part of the key", () => {
  const before = builds();
  buildStatus(store, { idleGapMs: 600_000, cache });
  expect(builds()).toBe(before + 1);
  const afterGap = builds();
  buildStatus(store, { idleGapMs: 600_000, cache, engine: engine("native Bend") });
  expect(builds()).toBe(afterGap + 1);
});

test("a cached projection still reports a ticking provisional session", () => {
  store.ingest({ source: "manual", instance: "cli", session: "sess", event: "start", kind: "session-start", at: 10_000, origin: "attested", project: "coral" }, 1);
  const before = builds();
  const first = buildStatus(store, { idleGapMs: 900_000, now: 20_000, cache });
  expect(builds()).toBe(before + 1);
  const second = buildStatus(store, { idleGapMs: 900_000, now: 30_000, cache });
  expect(builds()).toBe(before + 1); // still cached
  expect(first.current_session?.provisional_ms).toBe(10_000);
  expect(second.current_session?.provisional_ms).toBe(20_000);
  expect(second.coverage.open_sessions).toBe(1);
});

test("a binding change invalidates it too, since bindings back attribution", () => {
  const before = builds();
  store.bindProject("/repo/coral", "coral", true, "test");
  buildStatus(store, { idleGapMs: 900_000, cache });
  expect(builds()).toBe(before + 1);
});

afterAll(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
