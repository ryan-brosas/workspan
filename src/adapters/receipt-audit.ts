/**
 * Receipt audit: prove imported history is trustworthy before importing it.
 *
 * This is the first production caller of the Bend audit lane. It is read-only by
 * construction: it reads receipt files, classifies them against their counted
 * intervals and reports. It never writes to the database and never ingests, so it
 * is safe to run against real history before any migration is approved.
 *
 * Task labels are read because receipt identity includes them, but they are interned
 * into a variant index before anything reaches Bend, and this report never prints
 * them: statuses, durations and identifiers only.
 */
import { inspectJsonl, readChunks, readTurnRecords, type TimeRecord, type TurnChunk } from "../core/ledger.ts";
import { auditTurnReceipts, engineLabel, type NativeOptions } from "../core/native.ts";

export const AUDIT_STATUSES = ["consistent", "legacy", "missing", "checkpoint-only", "mismatch", "conflict"] as const;
export type AuditStatus = typeof AUDIT_STATUSES[number];

/** Statuses a person has to look at before trusting an import. */
export const REVIEW_STATUSES: readonly AuditStatus[] = ["conflict", "mismatch", "missing"];

export interface AuditOptions extends NativeOptions {
  turnsLog: string;
  chunksLog: string;
  label?: string;
}

export interface AuditRow { scope: string; id: string; status: AuditStatus; durable_ms: number; summary_copies: number }

export interface ReceiptAuditReport {
  source: { turns: string; chunks: string; label?: string };
  engine: string;
  input: { turns: number; chunks: number; scopes: number; malformed_lines: number };
  by_status: Record<AuditStatus, number>;
  rows: AuditRow[];
  /** Per scope: distinct receipt identities, and the counted evidence they hold. */
  scopes: Array<{ scope: string; receipts: number; counted_ms: number; review: number }>;
  review: string[];
  imported: 0;
}

const emptyCounts = (): Record<AuditStatus, number> => ({ consistent: 0, legacy: 0, missing: 0, "checkpoint-only": 0, mismatch: 0, conflict: 0 });

export function auditReceipts(options: AuditOptions): ReceiptAuditReport {
  const turnsInspect = inspectJsonl(options.turnsLog);
  const chunksInspect = inspectJsonl(options.chunksLog);
  const turns = readTurnRecords(options.turnsLog);
  const chunks = readChunks(options.chunksLog);

  // Bend audits one scope at a time: a receipt audit across scopes is a mistake it
  // refuses rather than averages.
  const scopes = [...new Set<string>([...turns.map(t => t.scope), ...chunks.map(c => c.scope)])].sort();
  const byStatus = emptyCounts();
  const rows: AuditRow[] = [];
  const review: string[] = [];
  const scopeRows: ReceiptAuditReport["scopes"] = [];

  for (const scope of scopes) {
    const audit = auditTurnReceipts(turns.filter(t => t.scope === scope), chunks.filter(c => c.scope === scope), options);
    // durableMs is the union of that identity's counted intervals, so summing across
    // identities totals the scope's counted evidence. It is not a measure total and
    // is never added to a summary's claimed duration.
    let countedMs = 0, reviewCount = 0;
    for (const [id, result] of audit) {
      byStatus[result.status]++;
      rows.push({ scope, id, status: result.status, durable_ms: result.durableMs, summary_copies: result.summaryCopies });
      countedMs += result.durableMs;
      if (REVIEW_STATUSES.includes(result.status)) { review.push(`${result.status}: ${id}`); reviewCount++; }
    }
    scopeRows.push({ scope, receipts: audit.size, counted_ms: countedMs, review: reviewCount });
  }

  return {
    source: { turns: options.turnsLog, chunks: options.chunksLog, ...(options.label ? { label: options.label } : {}) },
    engine: engineLabel(options),
    input: {
      turns: turns.length,
      chunks: chunks.length,
      scopes: scopes.length,
      malformed_lines: turnsInspect.malformedLines + chunksInspect.malformedLines,
    },
    by_status: byStatus,
    rows: rows.sort((a, b) => a.scope.localeCompare(b.scope) || a.id.localeCompare(b.id)),
    scopes: scopeRows,
    review,
    imported: 0,
  };
}

export type { TimeRecord, TurnChunk };
