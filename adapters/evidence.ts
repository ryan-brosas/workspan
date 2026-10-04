/**
 * What every harness adapter shares: the evidence envelope and a spooled emitter.
 *
 * The Pi adapter keeps its own presence-shaped wrapper because it also decodes
 * terminal input; the harness hooks below only translate lifecycle events, so they
 * build the envelope directly. Both go through the one client library.
 */
import { hostname } from "node:os";
import { join } from "node:path";
import { EvidenceSpool, drainOrphanedSpools, spoolDirectory } from "../src/client.ts";
import { EVIDENCE_VERSION } from "../src/daemon/evidence.ts";

/** The event the daemon validates; its allowlist is the authority, not this type. */
export interface EvidenceEvent {
  v: number;
  source: string;
  instance: string;
  session: string;
  event: string;
  kind: "interaction" | "agent-start" | "agent-end";
  at: number;
  origin: "human" | "automated" | "unknown";
  root?: string;
}

export interface Observation {
  /** A stable token for the transition; it becomes part of the event identity. */
  what: string;
  kind: EvidenceEvent["kind"];
  origin: EvidenceEvent["origin"];
  session: string;
  at: number;
  root?: string;
}

/**
 * One observation as the daemon's envelope. `source` and `what` are namespaced into
 * the event id so two observations at the same instant (a run starting and a prompt
 * arriving) are two identities, never one identity with conflicting metadata.
 */
export function evidenceFor(source: string, observation: Observation, instance: string = hostname()): EvidenceEvent {
  return {
    v: EVIDENCE_VERSION,
    source,
    instance,
    session: observation.session,
    event: `${source}-${observation.what}-${observation.at}`,
    kind: observation.kind,
    at: observation.at,
    origin: observation.origin,
    ...(observation.root ? { root: observation.root } : {}),
  };
}

/** A private per-process spool; the shared client owns the delivery rules. */
export function spoolFor(name: string, socketPath?: string, notify?: (message: string) => void): EvidenceSpool {
  return new EvidenceSpool({
    spoolPath: join(spoolDirectory(), `${name}-spool-${process.pid}.jsonl`),
    ...(socketPath ? { socketPath } : {}),
    ...(notify ? { onFull: notify } : {}),
  });
}

/**
 * Deliver what adapters that are gone left behind. Called once per adapter process
 * at startup: an adapter that is the only one running still recovers the others'
 * evidence, and the daemon's identity dedupe makes the replay safe.
 */
export async function drainAdapterSpools(socketPath?: string): Promise<number> {
  try { return await drainOrphanedSpools({ ...(socketPath ? { socketPath } : {}) }); }
  catch { return 0; }
}
