/**
 * Workspan opencode plugin.
 *
 * A run is opened by the first tool call or chat message in a session and closed by
 * the session settling (`session.idle`) or being deleted. That gives opencode's agent
 * runtime as one interval per run, never as a stream of tool calls, and it never
 * claims human attendance: a queued or scripted prompt is not a person.
 *
 * The transport and the spool live in `src/client.ts`, shared with the CLI, MCP and
 * the other adapters, so this plugin cannot drift from docs/protocol.md.
 */
import { evidenceFor, spoolFor, type Observation } from "../evidence.ts";

/**
 * The part of opencode's plugin contract this file implements. It is written out
 * rather than imported from `@opencode-ai/plugin`, which lives in opencode's own
 * installation: the runtime contract is structural, and the type checker here should
 * not depend on another tool's package layout.
 */
export interface OpencodePluginInput { directory: string; worktree: string }
export type OpencodePlugin = (input: OpencodePluginInput) => Promise<Record<string, unknown>>;

const SOURCE = "opencode";

/** The session a plugin event refers to, from whichever shape it arrives in. */
export function sessionOf(properties: unknown): string | null {
  const record = (properties ?? {}) as Record<string, unknown>;
  const info = record.info as Record<string, unknown> | undefined;
  const session = record.session as Record<string, unknown> | undefined;
  for (const candidate of [record.sessionID, record.sessionId, info?.sessionID, info?.id, session?.id]) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return null;
}

/** The directory a session is working in, when the event says so. */
export function directoryOf(properties: unknown): string | undefined {
  const record = (properties ?? {}) as Record<string, unknown>;
  const info = record.info as Record<string, unknown> | undefined;
  for (const candidate of [record.directory, record.cwd, info?.directory, info?.cwd]) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return undefined;
}

/**
 * One open run per session. A session can run several turns: the run closes on idle
 * and the next activity opens a new one, so the measure is the time the agent was
 * actually working rather than the lifetime of the session.
 */
export class RunTracker {
  private readonly open = new Map<string, { root?: string }>();

  private start(session: string, at: number, root?: string): Observation[] {
    if (this.open.has(session)) return [];
    this.open.set(session, { ...(root ? { root } : {}) });
    return [{ what: "run", kind: "agent-start", origin: "automated", session, at, ...(root ? { root } : {}) }];
  }

  /** A tool call means the agent is working. */
  toolCall(session: string, at: number, root?: string): Observation[] {
    return this.start(session, at, root);
  }

  /** A chat message is presence of unknown origin: queued and scripted prompts look the same. */
  message(session: string, at: number, root?: string): Observation[] {
    return [
      ...this.start(session, at, root),
      { what: "prompt", kind: "interaction", origin: "unknown", session, at, ...(root ? { root } : {}) },
    ];
  }

  /** The settle signal, from the event stream. Anything else is not tracked here. */
  settle(event: { type?: string; properties?: unknown }, at: number): Observation | null {
    const type = event.type ?? "";
    if (type !== "session.idle" && type !== "session.deleted") return null;
    const session = sessionOf(event.properties);
    if (!session) return null;
    const run = this.open.get(session);
    this.open.delete(session);
    if (!run) return null;
    return { what: type === "session.idle" ? "idle" : "deleted", kind: "agent-end", origin: "automated", session, at, ...(run.root ? { root: run.root } : {}) };
  }

  get openRuns(): number { return this.open.size; }
}

/** The plugin opencode loads: `server` is the module shape, the default export is the plugin. */
export const server: OpencodePlugin = async (input: OpencodePluginInput) => {
  const spool = spoolFor(SOURCE);
  const tracker = new RunTracker();
  const base = input.worktree || input.directory;
  const emit = (observations: Observation[]): void => {
    for (const observation of observations) {
      if (spool.append(evidenceFor(SOURCE, observation))) void spool.flush().catch(() => undefined);
    }
  };
  // The parameter shapes are written out rather than imported: the plugin package lives
  // in opencode's own installation, and a narrower parameter is what this plugin needs.
  return {
    "tool.execute.before": async ({ sessionID }: { sessionID: string }) => { emit(tracker.toolCall(sessionID, Date.now(), base)); },
    "chat.message": async ({ sessionID }: { sessionID: string }) => { emit(tracker.message(sessionID, Date.now(), base)); },
    event: async ({ event }: { event: { type?: string; properties?: unknown } }) => {
      const observation = tracker.settle(event, Date.now());
      if (observation) emit([observation]);
    },
    dispose: async () => { await spool.flush().catch(() => undefined); },
  };
};

export default server;
