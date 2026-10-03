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
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { hostname } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

/** Presence ticks land in fixed ten-second buckets: the same id for the same burst. */
export const TICK_MS = 10_000;
const PROTOCOL_VERSION = 1;
const MAX_SPOOL_BYTES = 10 * 1024 * 1024;

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

export function spoolDirectory(): string {
  return join(process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? "/home", ".local", "state"), "workspan");
}

/**
 * Per process: two Pi terminals flushing one shared spool race each other, and a
 * flush that renames the file empty can drop a line another process just appended.
 * A private spool cannot race; a dead process's spool is drained by the next one.
 */
export function defaultSpoolPath(): string {
  return join(spoolDirectory(), "pi-spool-" + process.pid + ".jsonl");
}

export async function drainOrphanedSpools(socketPath: string, directory: string = spoolDirectory()): Promise<void> {
  let names: string[] = [];
  try { names = readdirSync(directory).filter(name => /^pi-spool-\d+\.jsonl$/.test(name)); }
  catch { return; }
  for (const name of names) {
    const pid = Number(name.slice("pi-spool-".length).replace(/\.jsonl$/, ""));
    if (pid === process.pid) continue;
    let alive = true;
    try { process.kill(pid, 0); }
    catch (error) { alive = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    if (alive) continue;
    const path = join(directory, name);
    try {
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
      if (lines.length) await request(socketPath, "ingest", { events: lines.map(line => JSON.parse(line)) });
      rmSync(path, { force: true });
    } catch { /* undeliverable now: leave it for the next session to try */ }
  }
}

export type PresenceKind = "tick" | "turn-start" | "turn-end";
export interface PresenceObservation { what: PresenceKind; at: number; session: string; root?: string }

interface EvidenceEvent { v: number; source: string; instance: string; session: string; event: string; kind: string; at: number; origin: string; root?: string }

function toEvidence(observation: PresenceObservation, instance: string): EvidenceEvent {
  const base = { v: PROTOCOL_VERSION, source: "pi", instance, session: observation.session, at: observation.at, root: observation.root };
  if (observation.what === "tick") {
    return { ...base, event: "tick-" + Math.floor(observation.at / TICK_MS), kind: "interaction", origin: "human" };
  }
  // A settled turn is evidence a human was there to see it, so it carries presence
  // as well as runtime: work between questions belongs to the session.
  const kind = observation.what === "turn-start" ? "agent-start" : "agent-end";
  return { ...base, event: observation.what + "-" + observation.at, kind, origin: "automated" };
}

async function request(socketPath: string, method: string, params: unknown): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const client = connect(socketPath);
    let buffer = "";
    const id = randomUUID();
    client.setTimeout(5_000);
    client.on("connect", () => client.write(JSON.stringify({ v: PROTOCOL_VERSION, id, method, params }) + "\n"));
    client.on("data", chunk => {
      buffer += chunk.toString("utf8");
      const at = buffer.indexOf("\n");
      if (at === -1) return;
      try {
        const response = JSON.parse(buffer.slice(0, at)) as { ok: boolean; result?: unknown; error?: { code: string; message: string } };
        client.destroy();
        if (response.ok) resolvePromise(response.result);
        else reject(new Error(response.error ? response.error.code + ": " + response.error.message : "request failed"));
      } catch (error) { client.destroy(); reject(error); }
    });
    client.on("timeout", () => { client.destroy(); reject(new Error("daemon not responding")); });
    client.on("error", error => { client.destroy(); reject(error); });
  });
}

export interface EmitterOptions { socketPath: string; instance?: string; spoolPath?: string; notify?: (message: string) => void }

/** Spool first, then deliver; a failure leaves the spool for the next attempt. */
export class WorkspanEmitter {
  private readonly spoolPath: string;
  private readonly instance: string;
  private spoolFullNotice = false;

  constructor(private readonly options: EmitterOptions) {
    this.instance = options.instance ?? hostname();
    this.spoolPath = options.spoolPath ?? defaultSpoolPath();
    mkdirSync(dirname(this.spoolPath), { recursive: true, mode: 0o700 });
    if (!existsSync(this.spoolPath)) { writeFileSync(this.spoolPath, "", { mode: 0o600 }); chmodSync(this.spoolPath, 0o600); }
  }

  emit(observation: PresenceObservation): void {
    try {
      // A bounded spool with a visible complaint: silent coverage loss is the failure
      // mode this project exists to prevent.
      if (statSync(this.spoolPath).size > MAX_SPOOL_BYTES) {
        if (!this.spoolFullNotice) { this.spoolFullNotice = true; this.options.notify?.("Workspan: evidence spool is full; start the daemon to drain it"); }
        return;
      }
      appendFileSync(this.spoolPath, JSON.stringify(toEvidence(observation, this.instance)) + "\n");
      void this.flush().catch(() => undefined);
    } catch {
      // Tracking must never break the session it observes.
    }
  }

  async flush(): Promise<void> {
    if (!existsSync(this.spoolPath)) return;
    const lines = readFileSync(this.spoolPath, "utf8").split("\n").filter(Boolean);
    if (!lines.length) return;
    const events = lines.map(line => JSON.parse(line) as EvidenceEvent);
    await request(this.options.socketPath, "ingest", { events });
    // Delivered: rewrite the spool empty by rename, so a crash mid-write cannot lose it.
    const tmp = this.spoolPath + ".draining";
    writeFileSync(tmp, "", { mode: 0o600 });
    renameSync(tmp, this.spoolPath);
  }
}

type SessionCtx = {
  cwd?: string;
  mode?: string;
  sessionManager?: { getSessionId?: () => string | null };
  ui?: { onTerminalInput?: (handler: (data: string) => { consume?: boolean; data?: string } | undefined) => () => void; notify?: (message: string, type?: "info" | "warning" | "error") => void };
};

export default function workspanPiAdapter(pi: ExtensionAPI): void {
  const socketPath = process.env.WORKSPAN_SOCKET
    ?? join(process.env.XDG_RUNTIME_DIR ?? "/run/user/1000", "workspan", "workspan.sock");
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
    void emitter.flush().catch(() => undefined);
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
