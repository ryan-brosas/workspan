/**
 * Inferred attended-window policy: an evidence-bounded elapsed clock.
 *
 * Adapted from pi-time-tracker's automatic.ts (same revision as the inherited
 * core, MIT) with two changes: the terminal-input decoder stays in the Pi
 * adapter, and persistence goes through the WindowPort interface below instead
 * of importing a concrete store. The interval policy itself — first-signal
 * zero-length windows, the idle-gap cutoff, gap evidence, backward-clock
 * recovery and 10s checkpoints — is unchanged, and test/clock.test.ts is the
 * ported proof of it.
 */
import { randomUUID } from "node:crypto";

export const DEFAULT_IDLE_GAP_MS = 15 * 60_000;
const CHECKPOINT_MS = 10_000;

export interface ClockWorkspace { root: string; client: string }
export interface ClockWindow extends ClockWorkspace {
  id: string; sessionId: string; task: string; start: number; end: number; kind: "work" | "gap";
}

/**
 * Persistence port. The daemon implements this over its own ledger; the clock
 * owns only the interval policy and never opens storage itself.
 */
export interface WindowPort {
  latest(root: string, sessionId: string): ClockWindow | undefined;
  save(window: ClockWindow): void;
}

/** An evidence-bounded elapsed clock. Open session lifetime never supplies an end. */
export class AutomaticClock {
  private current?: ClockWindow;
  private last?: ClockWindow;
  private persistedEnd = -1;
  constructor(private port: WindowPort, private workspace: ClockWorkspace, private sessionId: string, private task: string, private idleGapMs = DEFAULT_IDLE_GAP_MS) {
    if (!Number.isSafeInteger(idleGapMs) || idleGapMs <= 0) throw new Error("idleGapMs must be a positive integer");
    this.last = port.latest(workspace.root, sessionId);
  }
  touch(at: number, checkpoint = false): void {
    if (!Number.isSafeInteger(at) || at < 0 || at > 8.64e15) throw new Error("Invalid activity timestamp");
    let previous = this.current ?? this.last;
    if (previous && at < previous.end) {
      // A backward clock must not manufacture time, but it must not freeze capture either:
      // keep what was already observed, then re-anchor from this observed timestamp.
      this.flush();
      this.current = undefined;
      this.last = undefined;
      previous = undefined;
    }
    const same = previous?.client === this.workspace.client && previous.task === this.task;
    const gap = previous ? at - previous.end : 0;
    if (!this.current || !same || gap > this.idleGapMs) {
      this.flush();
      if (previous && gap > this.idleGapMs) {
        this.port.save({ ...previous, id: randomUUID(), start: previous.end, end: at, kind: "gap" });
      }
      this.current = { ...this.workspace, id: randomUUID(), sessionId: this.sessionId, task: this.task, start: previous && same && gap <= this.idleGapMs ? previous.end : at, end: at, kind: "work" };
      this.persistedEnd = -1;
    } else this.current.end = at;
    if (checkpoint || this.persistedEnd < 0 || at - this.persistedEnd >= CHECKPOINT_MS) this.flush();
  }
  flush(): void {
    if (this.current && this.persistedEnd !== this.current.end) {
      this.port.save(this.current);
      this.persistedEnd = this.current.end;
    }
  }
}
