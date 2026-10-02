/**
 * Planner for migrating an existing Pi tracker's counted evidence.
 *
 * The evidence is the chunk ledger: one counted interval per chunk, many per turn.
 * Chunks are imported as agent-runtime evidence, never as attended work — a Pi turn
 * running is not proof of attendance. Summaries are durability receipts, not time:
 * importing them as well would count the same minutes twice, so they are handed to
 * the audit lane instead.
 *
 * Attribution is explicit. A scope name is not a client: unmapped scopes are
 * imported unallocated rather than guessed.
 */
import { inspectJsonl, readChunks } from "../core/ledger.ts";
import type { EvidenceEvent } from "../daemon/evidence.ts";

export interface ScopePlan {
  scope: string;
  /** The explicit mapping used, or null when the evidence stays unallocated. */
  project: string | null;
  chunks: number;
  turns: number;
  counted_ms: number;
}

export interface PiHistoryPlan {
  events: EvidenceEvent[];
  scopes: ScopePlan[];
  /** Scope names with no mapping; their evidence is imported, unallocated. */
  unmapped: string[];
  /**
   * `invalid_rows` is the difference between the lines the file holds and the rows
   * the typed reader kept: `readChunks` discards malformed or reversed rows without
   * a counter, so the migration reports the loss instead of inheriting it silently.
   */
  input: { chunks: number; invalid_rows: number; malformed_lines: number; skipped: number; instance: string };
}

export interface PiHistoryOptions {
  chunksLog: string;
  /** `scope` or its prefix before `-pi-turn` mapped to a project. */
  scopeMap?: Record<string, string>;
  instance?: string;
}

export const DEFAULT_INSTANCE = "pi-time-tracker";

/** `work-pi-turn` -> `work`; anything else is returned unchanged. */
export function scopePrefix(scope: string): string {
  const match = scope.match(/^(.*)-pi-turn$/);
  return match ? match[1] : scope;
}

export function planPiHistory(options: PiHistoryOptions): PiHistoryPlan {
  const instance = options.instance ?? DEFAULT_INSTANCE;
  const inspected = inspectJsonl(options.chunksLog);
  const chunks = readChunks(options.chunksLog);
  const map = options.scopeMap ?? {};
  const events: EvidenceEvent[] = [];
  const scopes = new Map<string, ScopePlan>();
  const unmapped = new Set<string>();
  let skipped = 0;

  // Ordered by start so identity ordinals are stable across runs; the ledger is
  // append-only in practice, but a replay must not renumber anything.
  const ordered = [...chunks].sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.turnId.localeCompare(b.turnId));
  const perTurn = new Map<string, number>();

  for (const chunk of ordered) {
    const start = Date.parse(chunk.start);
    const end = Date.parse(chunk.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) { skipped++; continue; }
    const project = map[chunk.scope] ?? map[scopePrefix(chunk.scope)];
    if (!project) unmapped.add(chunk.scope);
    const ordinal = perTurn.get(chunk.turnId) ?? 0;
    perTurn.set(chunk.turnId, ordinal + 1);
    const session = chunk.sessionId ?? chunk.scope;
    events.push({ source: "pi", instance, session, event: `${chunk.turnId}:c${ordinal}:start`, kind: "agent-start", at: start, origin: "automated", ...(project ? { project } : {}) });
    events.push({ source: "pi", instance, session, event: `${chunk.turnId}:c${ordinal}:end`, kind: "agent-end", at: end, origin: "automated", ...(project ? { project } : {}) });
    const row = scopes.get(chunk.scope) ?? { scope: chunk.scope, project: project ?? null, chunks: 0, turns: 0, counted_ms: 0 };
    row.chunks++;
    row.counted_ms += end - start;
    scopes.set(chunk.scope, row);
  }

  for (const [scope, row] of scopes) {
    const turns = new Set(ordered.filter(c => c.scope === scope).map(c => c.turnId));
    row.turns = turns.size;
  }

  return {
    events,
    scopes: [...scopes.values()].sort((a, b) => a.scope.localeCompare(b.scope)),
    unmapped: [...unmapped].sort(),
    input: {
      chunks: chunks.length,
      invalid_rows: Math.max(0, inspected.rows.length - chunks.length),
      malformed_lines: inspected.malformedLines,
      skipped,
      instance,
    },
  };
}
