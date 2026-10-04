import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createBackup, DEFAULT_BACKUP_KEEP, MAX_BACKUP_KEEP } from "../src/daemon/backup.ts";
import { SCHEMA_VERSION, WorkspanStore } from "../src/daemon/db.ts";
import type { EvidenceEvent, Kind } from "../src/daemon/evidence.ts";
import { buildStatus } from "../src/daemon/measures.ts";

const roots: string[] = [];
const stores: WorkspanStore[] = [];
const base = Date.parse("2026-10-02T12:00:00Z");
const event = (kind: Kind, at: number, id = kind): EvidenceEvent => ({
  source: "manual", instance: "fixture", session: "attested", event: id,
  kind, at, origin: "attested", project: "example", root: "/fixture/example",
});
function open(path: string): WorkspanStore {
  const store = new WorkspanStore(path);
  stores.push(store);
  return store;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workspan-backup-"));
  roots.push(root);
  return { root, directory: join(root, "backups"), store: open(join(root, "workspan.sqlite")) };
}
function restore(path: string, root: string): WorkspanStore {
  // Copy a completed, standalone snapshot, never the live WAL database.
  const target = join(root, "restored", "workspan.sqlite");
  mkdirSync(dirname(target), { mode: 0o700 });
  copyFileSync(path, target);
  return open(target);
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("a live WAL snapshot restores all three totals, identities and store state", () => {
  const { store, root, directory } = fixture();
  store.bindProject("/fixture/example", "example", true, "fixture");
  const start = event("session-start", base);
  for (const observation of [start, event("session-pause", base + 30_000), event("session-resume", base + 60_000), event("session-stop", base + 120_000)]) {
    store.ingest(observation, base);
  }
  for (const [kind, at] of [["agent-start", base + 30_000], ["agent-end", base + 90_000]] as const) {
    store.ingest({ ...event(kind, at), source: "pi", session: "turn", origin: "automated" }, base);
  }
  store.save({ id: "window", root: "/fixture/example", client: "example", sessionId: "presence", task: "fixture", start: base, end: base + 60_000, kind: "work" });
  store.addSessionNote(store.sessionKeyFromValue("attested"), "reviewed fixture", base + 120_000);
  store.ingest({ ...start, project: "conflicting" }, base);
  expect(statSync(`${store.path}-wal`).size).toBeGreaterThan(0);
  const options = { idleGapMs: 900_000, now: base + 180_000 };
  const expected = buildStatus(store, options);
  expect(expected.measures.attested.union_ms).toBe(90_000);
  expect(expected.measures.inferred.union_ms).toBe(60_000);
  expect(expected.measures.agent.union_ms).toBe(60_000);

  const backup = createBackup(store, { now: base });
  expect(dirname(backup.path)).toBe(directory);
  expect(backup).toMatchObject({ revision: store.revision(), identities: 6, schema_version: SCHEMA_VERSION, removed: 0 });
  expect(readdirSync(directory)).toEqual([backup.path.slice(directory.length + 1)]);
  const restored = restore(backup.path, root);
  expect(buildStatus(restored, options).measures).toEqual(expected.measures);
  expect(restored.revision()).toBe(backup.revision);
  expect(restored.observations()).toEqual(store.observations());
  expect(restored.observations()).toHaveLength(backup.identities);
  expect(restored.ingest(start).status).toBe("duplicate");
  expect(restored.sessionRows()).toEqual(store.sessionRows());
  expect(restored.sessionTransitions()).toEqual(store.sessionTransitions());
  expect(restored.sessionNotes()).toEqual(store.sessionNotes());
  expect(restored.windows()).toEqual(store.windows());
  expect(restored.conflictRows()).toEqual(store.conflictRows());
  expect(restored.sources()).toEqual(store.sources());
  expect(restored.projectBindings()).toEqual(store.projectBindings());
});

test("snapshot metadata stays at its captured revision while source ingestion continues", () => {
  const { store, root } = fixture();
  store.ingest(event("session-start", base));
  const capturedRevision = store.revision();
  const snapshot = store.snapshotTo.bind(store);
  spyOn(store, "snapshotTo").mockImplementationOnce(path => {
    snapshot(path);
    // A real snapshot, followed by ingestion before validation/metadata reporting.
    store.ingest(event("session-stop", base + 60_000));
  });
  const backup = createBackup(store, { now: base });
  expect(backup).toMatchObject({ revision: capturedRevision, identities: 1 });
  expect(store.revision()).toBeGreaterThan(backup.revision);
  expect(store.observations()).toHaveLength(2);
  const restored = restore(backup.path, root);
  expect(restored.observations()).toHaveLength(1);
  expect(restored.openSession()?.state).toBe("running");
  const next = createBackup(store, { now: base });
  expect(next.path).not.toBe(backup.path);
  expect(next).toMatchObject({ revision: store.revision(), identities: 2 });
});

test("an empty ledger has a valid zero-revision snapshot", () => {
  const { store } = fixture();
  expect(createBackup(store)).toMatchObject({ revision: 0, identities: 0, schema_version: SCHEMA_VERSION, removed: 0 });
});

test("managed directory and snapshots are private, including an existing loose directory", () => {
  const { store, directory } = fixture();
  // Pinned timestamps: an empty store keeps revision 0, so the two snapshots would be
  // distinguished only by the wall clock, and a same-millisecond pair could collide.
  const first = createBackup(store, { now: base });
  expect(statSync(directory).mode & 0o777).toBe(0o700);
  expect(statSync(first.path).mode & 0o777).toBe(0o600);
  chmodSync(directory, 0o777);
  const next = createBackup(store, { now: base + 1 });
  expect(statSync(directory).mode & 0o777).toBe(0o700);
  expect(statSync(next.path).mode & 0o777).toBe(0o600);
});

test("snapshotTo refuses all existing destinations, including empty files and symlinks", () => {
  const { store, root } = fixture();
  const empty = join(root, "empty.sqlite");
  const target = join(root, "sentinel");
  const link = join(root, "link.sqlite");
  const dangling = join(root, "dangling.sqlite");
  writeFileSync(empty, "");
  writeFileSync(target, "leave alone");
  symlinkSync(target, link);
  symlinkSync(join(root, "absent"), dangling);
  for (const path of [store.path, empty, target, link, dangling, root]) expect(() => store.snapshotTo(path)).toThrow();
  expect(readFileSync(empty, "utf8")).toBe("");
  expect(readFileSync(target, "utf8")).toBe("leave alone");
  expect(lstatSync(dangling).isSymbolicLink()).toBe(true);
  expect(store.observations()).toHaveLength(0);
});

test("a symlink managed directory is refused without writing to its target", () => {
  const { store, root, directory } = fixture();
  const outside = join(root, "outside");
  mkdirSync(outside, { mode: 0o755 });
  const mode = statSync(outside).mode;
  symlinkSync(outside, directory);
  expect(() => createBackup(store)).toThrow();
  expect(readdirSync(outside)).toEqual([]);
  expect(statSync(outside).mode).toBe(mode);
});

test.each(["file", "symlink"])("publication refuses a colliding %s without pruning", kind => {
  const { store, root, directory } = fixture();
  const previous = createBackup(store);
  const sentinel = join(root, "sentinel");
  writeFileSync(sentinel, "do not overwrite");
  const snapshot = store.snapshotTo.bind(store);
  let collision = "";
  spyOn(store, "snapshotTo").mockImplementationOnce(path => {
    snapshot(path);
    collision = path.slice(0, -".partial".length);
    if (kind === "symlink") symlinkSync(sentinel, collision);
    else writeFileSync(collision, "do not overwrite");
  });
  expect(() => createBackup(store, { keep: 1 })).toThrow();
  expect(readFileSync(collision, "utf8")).toBe("do not overwrite");
  expect(readFileSync(sentinel, "utf8")).toBe("do not overwrite");
  expect(existsSync(previous.path)).toBe(true);
  expect(readdirSync(directory).some(name => name.endsWith(".partial"))).toBe(false);
});

test("retention counts only validated managed snapshots, never evidence, spools or unsafe entries", () => {
  const { store, root, directory } = fixture();
  const old = createBackup(store, { now: base });
  const corrupt = createBackup(store, { now: base + 1 });
  writeFileSync(corrupt.path, "not a database");
  const unsafe = createBackup(store, { now: base + 2 });
  rmSync(unsafe.path);
  const evidence = join(root, "evidence.jsonl");
  writeFileSync(evidence, "fixture evidence");
  symlinkSync(evidence, unsafe.path);
  const linked = createBackup(store, { now: base + 3 });
  const alias = join(root, "external-backup.sqlite");
  linkSync(linked.path, alias);
  const sidecar = createBackup(store, { now: base + 4 });
  writeFileSync(`${sidecar.path}-wal`, "not a managed snapshot");
  const unmanaged = join(directory, "manual.sqlite");
  copyFileSync(old.path, unmanaged);
  const spool = join(directory, "pending.jsonl");
  writeFileSync(spool, "unacknowledged evidence");
  const partial = `${old.path}.partial`;
  writeFileSync(partial, "interrupted snapshot");
  const newest = createBackup(store, { keep: 1, now: base + 5 });
  expect(newest.removed).toBe(1);
  expect(existsSync(old.path)).toBe(false);
  for (const path of [newest.path, corrupt.path, unsafe.path, linked.path, alias, sidecar.path, `${sidecar.path}-wal`, unmanaged, evidence, spool, partial]) {
    expect(existsSync(path)).toBe(true);
  }
  expect(readFileSync(evidence, "utf8")).toBe("fixture evidence");
  expect(readFileSync(spool, "utf8")).toBe("unacknowledged evidence");
  expect(readFileSync(corrupt.path, "utf8")).toBe("not a database");
});

test("retention keeps the newest valid snapshots and protects a new snapshot after clock rollback", () => {
  const { store, directory } = fixture();
  const first = createBackup(store, { keep: 2, now: base });
  const second = createBackup(store, { keep: 2, now: base + 1 });
  const third = createBackup(store, { keep: 2, now: base + 2 });
  expect(third.removed).toBe(1);
  expect(existsSync(first.path)).toBe(false);
  expect(existsSync(second.path)).toBe(true);
  const backdated = createBackup(store, { keep: 2, now: base - 1 });
  expect(backdated.removed).toBe(1);
  expect(existsSync(second.path)).toBe(false);
  expect(existsSync(third.path)).toBe(true);
  expect(existsSync(backdated.path)).toBe(true);
  expect(readdirSync(directory)).toHaveLength(2);
});

test("retention accepts both positive bounds", () => {
  const { store } = fixture();
  const first = createBackup(store, { keep: MAX_BACKUP_KEEP, now: 0 });
  const next = createBackup(store, { keep: 1, now: Number.MAX_SAFE_INTEGER });
  expect(next.removed).toBe(1);
  expect(existsSync(first.path)).toBe(false);
  expect(existsSync(next.path)).toBe(true);
});

test("the default retention count is applied", () => {
  const { store, directory } = fixture();
  for (let i = 0; i < DEFAULT_BACKUP_KEEP; i++) expect(createBackup(store, { now: base + i }).removed).toBe(0);
  expect(createBackup(store, { now: base + DEFAULT_BACKUP_KEEP }).removed).toBe(1);
  expect(readdirSync(directory)).toHaveLength(DEFAULT_BACKUP_KEEP);
});

test.each([0, -1, 1.5, MAX_BACKUP_KEEP + 1, NaN, Infinity, null, "2"])("invalid keep %s is rejected before filesystem changes", keep => {
  const { store, directory } = fixture();
  // Exercise the runtime boundary even when a caller bypasses TypeScript.
  expect(() => createBackup(store, { keep: keep as number })).toThrow(/keep/);
  expect(existsSync(directory)).toBe(false);
});

test.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, "2"])("invalid now %s is rejected before filesystem changes", now => {
  const { store, directory } = fixture();
  expect(() => createBackup(store, { now: now as number })).toThrow(/now/);
  expect(existsSync(directory)).toBe(false);
});

test.each(["snapshot", "integrity", "schema", "revision"])("%s failure preserves every previous backup before pruning", failure => {
  const { store, directory } = fixture();
  const previous = [createBackup(store, { now: base }), createBackup(store, { now: base + 1 })];
  const contents = previous.map(backup => readFileSync(backup.path));
  if (failure === "snapshot") store.close();
  else {
    const snapshot = store.snapshotTo.bind(store);
    spyOn(store, "snapshotTo").mockImplementationOnce(path => {
      if (failure === "integrity") writeFileSync(path, "corrupt snapshot", { mode: 0o600 });
      else {
        snapshot(path);
        const db = new DatabaseSync(path);
        try {
          if (failure === "schema") db.prepare("update meta set value = ? where key = 'schema_version'").run(String(SCHEMA_VERSION + 1));
          // Upsert, not insert: meta is keyed and the snapshot already carries a revision
          // row, so a plain insert would throw here instead of exercising validation.
          else db.prepare("insert into meta(key, value) values('revision', '-1') on conflict(key) do update set value = excluded.value").run();
        } finally { db.close(); }
      }
    });
  }
  expect(() => createBackup(store, { keep: 1, now: base + 2 })).toThrow();
  expect(readdirSync(directory)).toHaveLength(2);
  for (const [i, backup] of previous.entries()) expect(readFileSync(backup.path)).toEqual(contents[i]);
});

test("optional packaged timer invokes only the daemon-backed backup client", () => {
  const packaging = join(import.meta.dir, "..", "packaging");
  const service = readFileSync(join(packaging, "workspan-backup.service"), "utf8");
  const timer = readFileSync(join(packaging, "workspan-backup.timer"), "utf8");
  expect(service).toContain("Type=oneshot");
  expect(service).toContain("ExecStart=%h/.local/bin/workspan backup --keep ${WORKSPAN_BACKUP_KEEP}");
  expect(service).toContain("Environment=WORKSPAN_RUNTIME_DIR=%t/workspan");
  expect(service).toContain(`Environment=WORKSPAN_BACKUP_KEEP=${DEFAULT_BACKUP_KEEP}`);
  expect(service).not.toContain("StateDirectory=");
  expect(service).not.toContain("RuntimeDirectory=");
  expect(timer).toContain("Unit=workspan-backup.service");
  expect(timer).toContain("OnCalendar=daily");
  expect(timer).toContain("Persistent=true");
});
