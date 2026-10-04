/**
 * Workspan Pi adapter.
 *
 * Runs alongside the existing tracker (shadow phase): it never opens the tracker's
 * database and never writes its ledgers, it only emits Workspan evidence to the
 * daemon. Two measures leave this file:
 *   - human terminal presence -> inferred attended windows (origin: human)
 *   - agent turn start/end   -> agent runtime (origin: automated)
 * It never emits prompts, tool payloads, window titles or a client name; the
 * workspace root is derived mechanically and the daemon resolves attribution from
 * bindings, because an adapter that named a client would be guessing it.
 *
 * Delivery is at-least-once: events go to a private spool first, then to the socket;
 * the daemon's identity dedupe makes replay safe.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, parseKey } from "@earendil-works/pi-tui";
import { hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
// The daemon transport and the spool rules live in the shared client library, so an
// adapter cannot drift from docs/protocol.md.
import { EvidenceSpool, defaultSocketPath, drainOrphanedSpools as drainSpools, spoolDirectory } from "../../src/client.ts";
import { EVIDENCE_VERSION } from "../../src/daemon/evidence.ts";

/** Presence ticks land in fixed ten-second buckets: the same id for the same burst. */
export const TICK_MS = 10_000;

/**
 * Decode only presence, never persist keys, pasted text, prompts or tool payloads.
 * Inherited from the tracker's semantics (MIT): focus reports, device responses and
 * mouse motion are not proof of work, and bracketed paste markers are stripped.
 */
export function isHumanInput(data: string): boolean {
  if (!data || isKeyRelease(data)) return false;
  if (/^\x1b\[(?:I|O|<)/.test(data) || /^\x1b\]/.test(data)) return false;
  if (parseKey(data) !== undefined) return true;
  const paste = data.replace(/\x1b\[20[01]~/g, "");
  return !paste.includes("\x1b") && /[^\x00-\x1f\x7f]/u.test(paste);
}

import { repositoryRoot } from "../../src/core/workspace.ts";

/** One walk to a repository root, shared with the CLI's focused-root derivation. */
export { repositoryRoot } from "../../src/core/workspace.ts";

/**
 * Per process: two Pi terminals flushing one shared spool race each other, and a
 * flush that renames the file empty can drop a line another process just appended.
 * A private spool cannot race; a dead process's spool is drained by the next one.
 */
export function defaultSpoolPath(): string {
  return join(spoolDirectory(), "pi-spool-" + process.pid + ".jsonl");
}

/** Evidence stranded by dead Pi processes; the daemon dedupes, so replay is safe. */
export async function drainOrphanedSpools(socketPath: string, directory: string = spoolDirectory()): Promise<void> {
  await drainSpools({ socketPath, directory, prefix: "pi-spool-" });
}

export type PresenceKind = "tick" | "turn-start" | "turn-end";
export interface PresenceObservation { what: PresenceKind; at: number; session: string; root?: string }

interface EvidenceEvent { v: number; source: string; instance: string; session: string; event: string; kind: string; at: number; origin: string; root?: string }

function toEvidence(observation: PresenceObservation, instance: string): EvidenceEvent {
  const base = { v: EVIDENCE_VERSION, source: "pi", instance, session: observation.session, at: observation.at, root: observation.root };
  if (observation.what === "tick") {
    const bucket = Math.floor(observation.at / TICK_MS);
    // Bucket identity requires bucket-stable metadata, including its timestamp.
    return { ...base, at: bucket * TICK_MS, event: "tick-v2-" + bucket, kind: "interaction", origin: "human" };
  }
  // A settled turn is evidence a human was there to see it, so it carries presence
  // as well as runtime: work between questions belongs to the session.
  const kind = observation.what === "turn-start" ? "agent-start" : "agent-end";
  return { ...base, event: observation.what + "-" + observation.at, kind, origin: "automated" };
}

export interface EmitterOptions { socketPath: string; instance?: string; spoolPath?: string; notify?: (message: string) => void }

/** Spool first, then deliver; a failure leaves the spool for the next attempt. */
export class WorkspanEmitter {
  private readonly instance: string;
  private readonly spool: EvidenceSpool;

  constructor(private readonly options: EmitterOptions) {
    this.instance = options.instance ?? hostname();
    // The shared spool owns the bounded-write and clear-only-after-accept rules; this
    // class only decides what an observation means.
    this.spool = new EvidenceSpool({
      spoolPath: options.spoolPath ?? defaultSpoolPath(),
      socketPath: options.socketPath,
      onFull: options.notify,
    });
  }

  emit(observation: PresenceObservation): void {
    try {
      if (!this.spool.append(toEvidence(observation, this.instance))) return;
      void this.flush().catch(() => undefined);
    } catch {
      // Tracking must never break the session it observes.
    }
  }

  async flush(): Promise<void> {
    // A failure stays visible to the caller: the adapter ignores it (the evidence is
    // still spooled), but nothing is lost silently.
    await this.spool.flush();
  }

  /** Flush, then remove the file if it is empty: an ended session leaves no litter. */
  async dispose(): Promise<void> {
    try { await this.spool.flush(); } catch { /* still spooled for the next process */ }
    this.spool.dispose();
  }
}

type SessionCtx = {
  cwd?: string;
  mode?: string;
  sessionManager?: { getSessionId?: () => string | null };
  ui?: { onTerminalInput?: (handler: (data: string) => { consume?: boolean; data?: string } | undefined) => () => void; notify?: (message: string, type?: "info" | "warning" | "error") => void };
};

export default function workspanPiAdapter(pi: ExtensionAPI): void {
  // One rule for every client: WORKSPAN_SOCKET wins, then the shared client's runtime
  // directory, which honours WORKSPAN_RUNTIME_DIR the way the CLI does.
  const socketPath = process.env.WORKSPAN_SOCKET ?? defaultSocketPath();
  const emitter = new WorkspanEmitter({ socketPath });

  // One process can host several sessions over its life - switches, automation,
  // resumed work - and more than one can be live at once. A second session must
  // never inherit the first one's identity, so roots are keyed by session and
  // terminal input attributes to whichever session is live when it happens.
  const roots = new Map<string, string>();
  let live: string | null = null;
  let inputBound = false;

  const sessionOf = (ctx?: SessionCtx): string | null => ctx?.sessionManager?.getSessionId?.() ?? live;
  const rootOf = (ctx?: SessionCtx): string => {
    const session = sessionOf(ctx);
    if (session && roots.has(session)) return roots.get(session)!;
    return repositoryRoot(ctx?.cwd ?? process.cwd());
  };
  const observe = (what: PresenceKind, at: number, ctx?: SessionCtx): void => {
    const session = sessionOf(ctx);
    if (!session) return;
    const root = rootOf(ctx);
    emitter.emit({ what, at, session, ...(root ? { root } : {}) });
  };

  pi.on("session_start", (_event, ctx) => {
    const session = ctx.sessionManager?.getSessionId?.() ?? randomUUID();
    roots.set(session, repositoryRoot(ctx.cwd ?? process.cwd()));
    live = session;
    // Evidence stranded by a crashed process is delivered here; the daemon dedupes
    // by identity, so a replay is always safe.
    void drainOrphanedSpools(socketPath).catch(() => undefined);
    // Registered once: the handler reads the live session when input happens, so a
    // switched or concurrent session cannot capture another one's keystrokes.
    if (!inputBound && ctx.mode === "tui" && typeof ctx.ui?.onTerminalInput === "function") {
      inputBound = true;
      ctx.ui.onTerminalInput((data: string) => {
        if (isHumanInput(data)) observe("tick", Date.now());
        return undefined;
      });
    }
  });

  // A switch can be vetoed, so state survives it; only drain what is already spooled.
  pi.on("session_before_switch", () => { void emitter.flush().catch(() => undefined); });
  pi.on("session_shutdown", (_event, ctx) => {
    void emitter.dispose().catch(() => undefined);
    const session = sessionOf(ctx);
    if (session) roots.delete(session);
    if (live === session) live = null;
  });

  pi.on("agent_start", (_event, ctx) => { observe("turn-start", Date.now(), ctx); });
  pi.on("agent_settled", (_event, ctx) => {
    const at = Date.now();
    observe("turn-end", at, ctx);
    // Presence at settlement: the human saw the result, so the session stays open.
    observe("tick", at, ctx);
    void emitter.flush().catch(() => undefined);
  });
}
