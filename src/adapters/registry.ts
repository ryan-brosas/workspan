/**
 * The harness registry: every local agent history Workspan can read, behind one
 * contract. Adding a harness means writing a reader and listing it here - the
 * daemon, the measures and the report never change.
 */
import type { EvidenceEvent, Source } from "../daemon/evidence.ts";
import { emptySummary, type HarnessReadOptions, type HarnessReader } from "./harness.ts";
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

/** Read every selected reader; one broken store must not hide the others. */
export function collectHarness(options: HarnessReadOptions & { id?: string } = {}): HarnessCollection[] {
  const { id, ...readOptions } = options;
  return harnessReaders()
    .filter(reader => !id || reader.id === id)
    .map(reader => {
      try {
        const { events, summary } = reader.read(readOptions);
        return { id: reader.id, source: reader.source, events, summary: { ...summary } as Record<string, unknown> };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { id: reader.id, source: reader.source, events: [], summary: { ...emptySummary(), error: message.slice(0, 140) } };
      }
    });
}
