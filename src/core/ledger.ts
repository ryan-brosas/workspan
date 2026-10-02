/**
 * Inherited from ryan-brosas/pi-time-tracker at 931c74c024a24ae7800a66fe21bccecbf19a945b (MIT).
 * Upstream sha256 1b8377654c7093e6da3c77eabd03994866c2b85bead72f29e32169c25e331ac6.
 * See docs/provenance.md: this copy is the successor implementation.
 */
import { appendFileSync, chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

// A silent gap is evidence of neither work nor absence. Cap it conservatively.
export const MAX_UNOBSERVED_MS = 5 * 60 * 1000;

export const TURN_SCOPE_SUFFIX = "-pi-turn";
export const SESSION_SCOPE_SUFFIX = "-user-session";

export type LabelSource = "prompt" | "tools" | "explicit";
export interface ActivityIdentity {
  label?: string;
  labelSource?: LabelSource;
  sessionId?: string;
}

export interface TimeRecord extends ActivityIdentity {
  version: 1;
  id: string;
  startedAt: string;
  endedAt: string;
  observedMs: number;
  outcome: "settled" | "interrupted";
  scope: string;
  /** This producer also writes counted interval evidence. */
  intervalVersion?: 2;
}

/** Wall-clock interval of counted activity within one turn (v2). */
export interface TurnChunk extends ActivityIdentity {
  version: 2;
  turnId: string;
  scope: string;
  start: string;
  end: string;
  ms: number;
  capped: boolean;
}

export type ChunkSink = (chunk: TurnChunk) => void;

export interface SessionEvent {
  version: 1;
  kind: "session-start" | "session-stop";
  id: string;
  at: string;
  scope: string;
  label?: string;
  note?: string;
}

export interface WorkSession {
  id: string;
  label?: string;
  startedAt: number;
  endedAt: number | null;
  scope: string;
}

export interface Interval { start: number; end: number }

const iso = (t: number) => new Date(t).toISOString();

/** One agent run. Emits interval evidence through `sink` and summarizes it as a v1 record. */
export class Turn {
  readonly id = randomUUID();
  private readonly scope: string;
  private readonly sink: ChunkSink;
  private readonly startedAt: number;
  private lastObservedAt: number;
  private activeMs = 0;
  private paused = false;
  private windowStart: number | null = null;
  private windowEnd = 0;
  private windowCapped = false;
  private lastCheckpointAt: number;

  constructor(scope: string, sink: ChunkSink, at: number) {
    this.scope = scope;
    this.sink = sink;
    this.startedAt = at;
    this.lastObservedAt = at;
    this.lastCheckpointAt = at;
  }

  private emitWindow(): void {
    if (this.windowStart !== null && this.windowEnd > this.windowStart) {
      this.sink({
        version: 2, turnId: this.id, scope: this.scope,
        start: iso(this.windowStart), end: iso(this.windowEnd),
        ms: this.windowEnd - this.windowStart, capped: this.windowCapped,
      });
    }
    this.windowStart = null;
    this.windowEnd = 0;
    this.windowCapped = false;
  }

  private count(at: number): void {
    if (at <= this.lastObservedAt) return; // clock moved backwards, or no elapsed time
    const gap = at - this.lastObservedAt;
    const counted = Math.min(gap, MAX_UNOBSERVED_MS);
    if (this.windowStart === null || this.windowEnd !== this.lastObservedAt) this.emitWindow();
    if (this.windowStart === null) {
      this.windowStart = this.lastObservedAt;
      this.windowEnd = this.lastObservedAt;
    }
    this.windowEnd = this.lastObservedAt + counted;
    if (gap > MAX_UNOBSERVED_MS) this.windowCapped = true;
    this.activeMs += counted;
    this.lastObservedAt = at;
  }

  event(at: number): void {
    if (this.paused) return;
    this.count(at);
    // Event-driven durability, never a timer or background poll.
    if (at - this.lastCheckpointAt >= 60_000) {
      this.checkpoint();
      this.lastCheckpointAt = at;
    }
  }

  checkpoint(): void { this.emitWindow(); }

  pause(at: number): void {
    if (this.paused) return;
    this.count(at);
    this.paused = true;
    this.emitWindow();
  }

  resume(at: number): void {
    if (!this.paused) return;
    this.paused = false;
    if (at > this.lastObservedAt) this.lastObservedAt = at;
  }

  private record(endedAt: number, outcome: TimeRecord["outcome"]): TimeRecord | null {
    if (this.activeMs < 1000) return null;
    return {
      version: 1, id: this.id, startedAt: iso(this.startedAt),
      endedAt: iso(Math.max(endedAt, this.lastObservedAt, this.startedAt)),
      observedMs: Math.floor(this.activeMs), outcome, scope: this.scope, intervalVersion: 2,
    };
  }

  settle(at: number): TimeRecord | null {
    if (!this.paused) this.count(at);
    this.emitWindow();
    return this.record(at, "settled");
  }

  interrupt(at: number): TimeRecord | null {
    this.emitWindow();
    return this.record(this.lastObservedAt, "interrupted");
  }
}

export function appendJsonl(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, "a+", 0o600);
  try {
    const size = fstatSync(fd).size, last = Buffer.alloc(1);
    if (size) readSync(fd, last, 0, 1, size - 1);
    // Preserve a torn tail as a rejected line instead of swallowing the next receipt.
    const separator = size && last[0] !== 10 ? "\n" : "";
    appendFileSync(fd, separator + JSON.stringify(value) + "\n", "utf8");
    chmodSync(path, 0o600);
  } finally { closeSync(fd); }
}

export function writeFilePrivate(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

export function inspectJsonl(path: string): { rows: unknown[]; malformedLines: number } {
  if (!existsSync(path)) return { rows: [], malformedLines: 0 };
  const rows: unknown[] = [];
  let malformedLines = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { malformedLines++; }
  }
  return { rows, malformedLines };
}
const readJsonl = (path: string) => inspectJsonl(path).rows;

function identity(row: Record<string, unknown>): ActivityIdentity {
  return {
    ...(typeof row.label === "string" ? { label: row.label } : {}),
    ...(["prompt", "tools", "explicit"].includes(String(row.labelSource)) ? { labelSource: row.labelSource as LabelSource } : {}),
    ...(typeof row.sessionId === "string" ? { sessionId: row.sessionId } : {}),
  };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function readTurnRecords(path: string): TimeRecord[] {
  return readJsonl(path).flatMap((row): TimeRecord[] => {
    if (!isObject(row) || row.version !== 1 || typeof row.id !== "string" || typeof row.scope !== "string" || !row.scope.endsWith(TURN_SCOPE_SUFFIX)) return [];
    const startedAt = typeof row.startedAt === "string" ? Date.parse(row.startedAt) : NaN;
    const endedAt = typeof row.endedAt === "string" ? Date.parse(row.endedAt) : NaN;
    const observedMs = typeof row.observedMs === "number" ? row.observedMs : NaN;
    const outcome = row.outcome;
    if (row.intervalVersion !== undefined && row.intervalVersion !== 2) return [];
    if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt || !Number.isSafeInteger(observedMs) || observedMs < 0 || observedMs > endedAt - startedAt || (outcome !== "settled" && outcome !== "interrupted")) return [];
    return [{ version: 1, id: row.id, startedAt: new Date(startedAt).toISOString(), endedAt: new Date(endedAt).toISOString(), observedMs, outcome, scope: row.scope, ...identity(row), ...(row.intervalVersion === 2 ? { intervalVersion: 2 as const } : {}) }];
  });
}

export function readChunks(path: string): TurnChunk[] {
  return readJsonl(path).flatMap((row): TurnChunk[] => {
    if (!isObject(row) || row.version !== 2 || typeof row.turnId !== "string" || typeof row.scope !== "string" || !row.scope.endsWith(TURN_SCOPE_SUFFIX)) return [];
    const start = typeof row.start === "string" ? Date.parse(row.start) : NaN;
    const end = typeof row.end === "string" ? Date.parse(row.end) : NaN;
    const ms = typeof row.ms === "number" ? row.ms : NaN;
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(ms) || ms <= 0 || end <= start || ms !== end - start) return [];
    return [{ version: 2, turnId: row.turnId, scope: row.scope, start: new Date(start).toISOString(), end: new Date(end).toISOString(), ms, capped: row.capped === true, ...identity(row) }];
  });
}

export function readWorkSessions(path: string): WorkSession[] {
  const events = readJsonl(path).flatMap((row): SessionEvent[] => {
    if (!isObject(row) || row.version !== 1 || typeof row.id !== "string" || typeof row.scope !== "string" || !row.scope.endsWith(SESSION_SCOPE_SUFFIX)) return [];
    const kind = row.kind;
    const at = typeof row.at === "string" ? Date.parse(row.at) : NaN;
    if (!Number.isFinite(at) || (kind !== "session-start" && kind !== "session-stop")) return [];
    return [{ version: 1, kind, id: row.id, at: new Date(at).toISOString(), scope: row.scope, label: typeof row.label === "string" ? row.label : undefined, note: typeof row.note === "string" ? row.note : undefined }];
  });
  const sessions: WorkSession[] = [];
  for (const event of events) {
    if (event.kind !== "session-start") continue;
    const stop = events.filter(e => e.kind === "session-stop" && e.id === event.id && e.scope === event.scope && Date.parse(e.at) >= Date.parse(event.at)).at(-1);
    sessions.push({ id: event.id, label: event.label, startedAt: Date.parse(event.at), endedAt: stop ? Date.parse(stop.at) : null, scope: event.scope });
  }
  return sessions.sort((a, b) => a.startedAt - b.startedAt);
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>();
function dayFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = dayFormatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hourCycle: "h23" });
    dayFormatters.set(tz, fmt);
  }
  return fmt;
}

export function localDayKey(at: number, tz: string): string {
  return dayFormatter(tz).format(new Date(at));
}

export function splitIntervalByLocalDay(start: number, end: number, tz: string): Array<{ day: string; ms: number }> {
  if (end <= start) return [];
  const parts: Array<{ day: string; ms: number }> = [];
  let lo = start;
  while (lo < end) {
    const day = localDayKey(lo, tz);
    if (localDayKey(end - 1, tz) === day) { parts.push({ day, ms: end - lo }); break; }
    let a = lo, b = end;
    while (b - a > 1) {
      const mid = Math.floor((a + b) / 2);
      if (localDayKey(mid, tz) === day) a = mid; else b = mid;
    }
    parts.push({ day, ms: b - lo });
    lo = b;
  }
  return parts;
}
