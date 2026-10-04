/**
 * The harness registry: every local agent history Workspan can read, behind one
 * contract. Adding a harness means writing a reader and listing it here - the
 * daemon, the measures and the report never change.
 */
import type { EvidenceEvent, Source } from "../daemon/evidence.ts";
import { emptySummary, unavailable, type HarnessProbe, type HarnessReadOptions, type HarnessReader } from "./harness.ts";
import { claudeReader } from "./claude.ts";
import { codexReader } from "./codex.ts";
import { opencodeReader } from "./opencode.ts";

export function harnessReaders(): HarnessReader[] {
  return [codexReader, opencodeReader, claudeReader];
}

export interface HarnessCollection {
  id: string;
  source: Source;
  events: EvidenceEvent[];
  summary: Record<string, unknown>;
}

/** Availability and freshness per reader: store metadata only, never records. */
export interface HarnessProbeRow extends HarnessProbe {
  id: string;
  source: Source;
  /** A reader that could not even be probed is named here, and never hides the others. */
  error?: string;
}

function messageOf(error: unknown): string {
  // A blank Error or a bare object must still name the broken reader: an empty or
  // "[object Object]" diagnostic leaves the store that failed unidentified.
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  if (message.trim()) return message.trim().slice(0, 140);
  const thrown = typeof error === "object" && error !== null ? error as { code?: unknown } : null;
  const code = thrown && typeof thrown.code === "string" ? ` (${thrown.code})` : "";
  return `${error === null ? "null" : typeof error}${code} thrown without a message`.slice(0, 140);
}

/** Cheap detection pass: which stores exist and how fresh they are. */
export function probeHarness(options: { now?: number; readers?: HarnessReader[] } = {}): HarnessProbeRow[] {
  const now = options.now ?? Date.now();
  return (options.readers ?? harnessReaders()).map(reader => {
    try {
      return { id: reader.id, source: reader.source, ...reader.probe({ now }) };
    } catch (error) {
      return { id: reader.id, source: reader.source, ...unavailable(), error: messageOf(error) };
    }
  });
}

/** Read every selected reader; one broken store must not hide the others. */
export function collectHarness(options: HarnessReadOptions & { id?: string; readers?: HarnessReader[] } = {}): HarnessCollection[] {
  const { id, readers, ...readOptions } = options;
  return (readers ?? harnessReaders())
    .filter(reader => !id || reader.id === id)
    .map(reader => {
      try {
        const { events, summary } = reader.read(readOptions);
        return { id: reader.id, source: reader.source, events, summary: { ...summary } as Record<string, unknown> };
      } catch (error) {
        return { id: reader.id, source: reader.source, events: [], summary: { ...emptySummary(), error: messageOf(error) } };
      }
    });
}
