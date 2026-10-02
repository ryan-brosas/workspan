import { expect, test } from "bun:test";
import { AutomaticClock, DEFAULT_IDLE_GAP_MS, type ClockWindow, type WindowPort } from "../src/core/clock.ts";
import { reconcileIntervals } from "../src/core/native.ts";

/**
 * Ported from pi-time-tracker's automatic.test.ts (same revision as the
 * inherited core). Every assertion is upstream's; only the harness changed —
 * the clock now takes a WindowPort, so this double stands in for the daemon's
 * store.
 *
 * The double encodes the ordering contract the real store must satisfy:
 *   windows(root)          ascending by start
 *   latest(root, session)  the greatest end
 *   save(window)           upsert by id, never a second row for one window
 * Storage is keyed by path so the reopen/restart tests stay faithful.
 */
const backing = new Map<string, ClockWindow[]>();

class MemoryStore implements WindowPort {
  constructor(private readonly path: string) { if (!backing.has(path)) backing.set(path, []); }
  private get rows(): ClockWindow[] { return backing.get(this.path)!; }
  latest(root: string, sessionId: string): ClockWindow | undefined {
    return this.rows
      .filter(r => r.root === root && r.sessionId === sessionId)
      .reduce<ClockWindow | undefined>((best, row) => (!best || row.end >= best.end ? row : best), undefined);
  }
  save(window: ClockWindow): void {
    const rows = this.rows;
    const at = rows.findIndex(r => r.id === window.id);
    if (at === -1) rows.push({ ...window });
    else rows[at] = { ...window };
  }
  windows(root: string): ClockWindow[] {
    return this.rows.filter(r => r.root === root).slice().sort((a, b) => a.start - b.start);
  }
  close(): void {}
}

let fixtures = 0;
function fixture() {
  const path = `memory://store-${fixtures++}`;
  const store = new MemoryStore(path);
  return { path, store, ws: { root: `/project-${path}`, client: "Coral" } };
}
const openStore = (path: string) => new MemoryStore(path);
const closeStore = (store: MemoryStore) => store.close();

test("defaults the idle gap to fifteen minutes", () => {
  expect(DEFAULT_IDLE_GAP_MS).toBe(15 * 60_000);
});

test("first signal opens a zero-length window, short gaps join, long gaps become excluded evidence", () => {
  const { store, ws } = fixture();
  const clock = new AutomaticClock(store, ws, "sess-1", "invoices", 900_000);
  clock.touch(1_000);
  clock.touch(1_500);
  clock.flush();
  clock.touch(301_500); // a five-minute review gap joins
  clock.flush();
  let rows = store.windows(ws.root);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: "work", start: 1_000, end: 301_500, client: "Coral", task: "invoices", sessionId: "sess-1" });
  clock.touch(1_501_500); // twenty minutes later: excluded, not counted
  clock.touch(1_506_500);
  clock.flush();
  rows = store.windows(ws.root);
  expect(rows).toHaveLength(3);
  expect(rows[1]).toMatchObject({ kind: "gap", start: 301_500, end: 1_501_500 });
  expect(rows[2]).toMatchObject({ kind: "work", start: 1_501_500, end: 1_506_500 });
  const beforeRegression = rows;
  clock.touch(1_400_000); // A backward jump opens a fresh zero-duration window.
  clock.flush();
  rows = store.windows(ws.root);
  expect(rows).toHaveLength(4);
  expect(rows.filter(r => beforeRegression.some(previous => previous.id === r.id))).toEqual(beforeRegression);
  expect(rows.find(r => r.start === 1_400_000)).toMatchObject({ kind: "work", end: 1_400_000 });
});

test("a restored clock continues a live session but never counts idle session lifetime", () => {
  const { store, path, ws } = fixture();
  const first = new AutomaticClock(store, ws, "sess-1", "invoices", 900_000);
  first.touch(1_000); first.touch(2_000); first.flush();
  closeStore(store);
  const reopened = openStore(path);
  const resumed = new AutomaticClock(reopened, ws, "sess-1", "invoices", 900_000);
  resumed.touch(402_000); resumed.flush();
  let rows = reopened.windows(ws.root);
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatchObject({ start: 2_000, end: 402_000 });
  const later = new AutomaticClock(reopened, ws, "sess-1", "invoices", 900_000);
  later.touch(2_402_000); later.flush();
  rows = reopened.windows(ws.root);
  expect(rows).toHaveLength(4);
  expect(rows[2]).toMatchObject({ kind: "gap", start: 402_000, end: 2_402_000 });
  expect(rows[3]).toMatchObject({ kind: "work", start: 2_402_000, end: 2_402_000 });
  closeStore(reopened);
});

test("backward clocks preserve prior evidence and recover without counting the jump, including after restart", () => {
  const { store, path, ws } = fixture();
  const clock = new AutomaticClock(store, ws, "sess", "task");
  clock.touch(10_000);
  clock.touch(15_000);
  expect(store.latest(ws.root, "sess")?.end).toBe(10_000);
  clock.touch(1_000, true);
  expect(store.windows(ws.root).map(({ start, end, kind }) => ({ start, end, kind }))).toEqual([
    { start: 1_000, end: 1_000, kind: "work" },
    { start: 10_000, end: 15_000, kind: "work" },
  ]);
  clock.touch(2_000, true);
  expect(store.windows(ws.root)[0]).toMatchObject({ start: 1_000, end: 2_000 });
  closeStore(store);
  const reopened = openStore(path);
  const restored = new AutomaticClock(reopened, ws, "sess", "task");
  restored.touch(0, true);
  restored.touch(1_000, true);
  const rows = reopened.windows(ws.root);
  expect(rows).toHaveLength(3);
  expect(rows.map(({ start, end, kind }) => ({ start, end, kind }))).toEqual([
    { start: 0, end: 1_000, kind: "work" },
    { start: 1_000, end: 2_000, kind: "work" },
    { start: 10_000, end: 15_000, kind: "work" },
  ]);
  expect(rows.reduce((sum, row) => sum + row.end - row.start, 0)).toBe(7_000);
});

for (const change of ["client", "task"] as const) test(`long quiet gaps survive a ${change} change`, () => {
  const { store, ws } = fixture();
  const first = new AutomaticClock(store, ws, "sess", "old task", 10_000);
  first.touch(1_000); first.touch(2_000); first.flush();
  const switched = new AutomaticClock(store, change === "client" ? { ...ws, client: "Other" } : ws, "sess", change === "task" ? "new task" : "old task", 10_000);
  switched.touch(20_000, true);
  const rows = store.windows(ws.root);
  expect(rows).toHaveLength(3);
  expect(rows[1]).toMatchObject({ kind: "gap", client: "Coral", task: "old task", start: 2_000, end: 20_000 });
  expect(rows[2]).toMatchObject({ kind: "work", client: change === "client" ? "Other" : "Coral", task: change === "task" ? "new task" : "old task", start: 20_000, end: 20_000 });
});

test("two live clocks for one session and root overlap raw rows while the union still counts once", () => {
  const { store, ws } = fixture();
  const a = new AutomaticClock(store, ws, "shared", "task", 900_000);
  const b = new AutomaticClock(store, ws, "shared", "task", 900_000);
  a.touch(1_000, true); b.touch(1_500, true); a.touch(2_000, true); b.touch(2_500, true);
  const rows = store.windows(ws.root).filter(r => r.kind === "work");
  expect(rows.map(r => [r.start, r.end])).toEqual([[1_000, 2_000], [1_500, 2_500]]);
  expect(rows.reduce((sum, r) => sum + (r.end - r.start), 0)).toBe(2_000); // raw rows are additive and overlap
  const [union] = reconcileIntervals([rows.map(r => ({ start: r.start, end: r.end }))]);
  expect(union).toBe(1_500);
});

test("client or task changes open a fresh window and never reattribute recorded rows", () => {
  const { store, ws } = fixture();
  const first = new AutomaticClock(store, ws, "sess-1", "invoices", 900_000);
  first.touch(1_000); first.touch(2_000); first.flush();
  const switched = new AutomaticClock(store, ws, "sess-1", "onboarding", 900_000);
  switched.touch(60_000); switched.flush();
  const relabeled = new AutomaticClock(store, { ...ws, client: "Other" }, "sess-1", "onboarding", 900_000);
  relabeled.touch(61_000); relabeled.touch(62_000); relabeled.flush();
  const rows = store.windows(ws.root);
  expect(rows).toHaveLength(3);
  expect(rows[0]).toMatchObject({ task: "invoices", end: 2_000 });
  expect(rows[1]).toMatchObject({ client: "Coral", task: "onboarding", start: 60_000, end: 60_000 });
  expect(rows[2]).toMatchObject({ client: "Other", task: "onboarding", start: 61_000, end: 62_000 });
  expect(() => new AutomaticClock(store, ws, "sess-1", "task", 0)).toThrow("positive integer");
});
