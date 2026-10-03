import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomaticClock } from "../src/core/clock.ts";
import { clockScope, WorkspanStore } from "../src/daemon/db.ts";
import type { EvidenceEvent } from "../src/daemon/evidence.ts";
import { buildStatus } from "../src/daemon/measures.ts";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workspan-replay-"));
  roots.push(root);
  return { store: new WorkspanStore(join(root, "tracker.sqlite")), root };
}
const base = 1_700_000_000_000;
const event: EvidenceEvent = {
  source: "pi", instance: "laptop", session: "s1", event: "e1",
  kind: "interaction", at: base, origin: "human", project: "coral",
};

/** Drives the inferred-window clock exactly as the daemon does: inside the ingest transaction. */
function ingestHuman(store: WorkspanStore, e: EvidenceEvent, project = e.project) {
  const scope = clockScope({ root: e.root, project }, e.session);
  const clock = new AutomaticClock(store, scope, scope.sessionId, scope.task, 900_000);
  return store.ingest(e, 1, () => clock.touch(e.at));
}

test("replaying one observation neither duplicates evidence nor moves any measure", () => {
  const { store } = fixture();
  expect(ingestHuman(store, event).status).toBe("accepted");
  expect(ingestHuman(store, event).status).toBe("duplicate");
  expect(ingestHuman(store, event).status).toBe("duplicate");
  expect(store.observations()).toHaveLength(1);
  expect(store.conflictRows()).toHaveLength(0);
  expect(buildStatus(store, { idleGapMs: 900_000 }).coverage.events).toBe(1);
});

test("retry timing is not part of identity, so a late redelivery is still a duplicate", () => {
  const { store } = fixture();
  const scope = clockScope({ root: event.root, project: event.project }, event.session);
  const clock = new AutomaticClock(store, scope, scope.sessionId, scope.task, 900_000);
  expect(store.ingest(event, 1, () => clock.touch(event.at)).status).toBe("accepted");
  expect(store.ingest(event, Date.now() + 86_400_000, () => clock.touch(event.at)).status).toBe("duplicate");
});

test("changed metadata under one identity is a visible conflict, never an overwrite", () => {
  const { store } = fixture();
  ingestHuman(store, event);
  const later: EvidenceEvent = { ...event, event: "e2", at: base + 300_000 };
  ingestHuman(store, later);
  expect(buildStatus(store, { idleGapMs: 900_000 }).measures.inferred.projects).toEqual([{ project: "coral", ms: 300_000 }]);

  // A redelivery of e1 that claims a different client must not reattribute the hours.
  expect(ingestHuman(store, { ...event, project: "other-client" }).status).toBe("conflict");
  const rows = store.conflictRows();
  expect(rows).toHaveLength(1);
  expect(rows[0].reason).toBe("metadata_changed");
  expect(store.observations().find(o => o.event === "e1")?.project).toBe("coral");

  const status = buildStatus(store, { idleGapMs: 900_000 });
  expect(status.coverage.conflicts).toBe(1);
  expect(status.measures.inferred.projects).toEqual([{ project: "coral", ms: 300_000 }]);
});

test("a second conflict on the same identity is recorded once and stays visible", () => {
  const { store } = fixture();
  ingestHuman(store, event);
  expect(ingestHuman(store, { ...event, project: "a" }).status).toBe("conflict");
  expect(ingestHuman(store, { ...event, project: "b" }).status).toBe("conflict");
  expect(store.conflictRows()).toHaveLength(1);
  expect(store.observations()).toHaveLength(1);
});

afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
