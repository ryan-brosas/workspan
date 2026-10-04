/**
 * Workspan opencode plugin (V2).
 *
 * A run is opened by the first tool call or chat message in a session and closed by
 * the session settling (the V2 `session.execution.*` signals, or `session.idle`) or
 * being deleted. That gives opencode's agent runtime as one interval per run, never
 * as a stream of tool calls, and it never claims human attendance: a queued or
 * scripted prompt is not a person.
 *
 * The transport and the spool live in `src/client.ts`, shared with the CLI, MCP and
 * the other adapters, so this plugin cannot drift from docs/protocol.md.
 */
import { drainAdapterSpools, evidenceFor, spoolFor, type Observation } from "../evidence.ts";

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

/** The signals that end a turn in V2, plus the legacy idle name. */
const SETTLE_EVENTS = new Set([
  "session.idle",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]);

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
    if (type !== "session.deleted" && !SETTLE_EVENTS.has(type)) return null;
    const session = sessionOf(event.properties);
    if (!session) return null;
    const run = this.open.get(session);
    this.open.delete(session);
    if (!run) return null;
    return { what: type === "session.deleted" ? "deleted" : "idle", kind: "agent-end", origin: "automated", session, at, ...(run.root ? { root: run.root } : {}) };
  }

  get openRuns(): number { return this.open.size; }
}

/** One settlement event from opencode's V2 event stream. */
interface OpencodeStreamEvent { type?: string; data?: unknown }

/**
 * The narrow slice of opencode's V2 plugin context this adapter uses. It is written
 * out rather than imported from `@opencode/plugin`, which lives in opencode's own
 * installation: the runtime contract is structural, and the type checker here should
 * not depend on another tool's package layout.
 */
export interface OpencodePluginContext {
  readonly location?: { directory?: string; project?: { directory?: string; canonical?: string } };
  readonly tool: { hook(name: "execute.before", callback: (event: unknown) => void): Promise<unknown> };
  readonly session: { hook(name: "prompt", callback: (event: unknown) => void): Promise<unknown> };
  readonly event: { subscribe(options?: { signal?: AbortSignal }): AsyncIterable<OpencodeStreamEvent> };
}

/**
 * The plugin opencode loads: a default definition with an id and a setup function.
 * Setup registers the hooks, drains settlement events for the process lifetime, and
 * returns the cleanup opencode runs on unload.
 */
export const plugin = {
  id: "workspan-opencode",
  async setup(ctx: OpencodePluginContext): Promise<() => void> {
    // Evidence stranded by a previous opencode process is delivered here: this
    // plugin may be the only adapter running when the daemon comes back.
    void drainAdapterSpools();
    const spool = spoolFor(SOURCE);
    const tracker = new RunTracker();
    const base = ctx.location?.directory ?? ctx.location?.project?.directory ?? ctx.location?.project?.canonical;
    const emit = (observations: Observation[]): void => {
      for (const observation of observations) {
        if (spool.append(evidenceFor(SOURCE, observation))) void spool.flush().catch(() => undefined);
      }
    };
    await ctx.tool.hook("execute.before", (event) => {
      const session = sessionOf(event);
      if (session) emit(tracker.toolCall(session, Date.now(), base));
    });
    await ctx.session.hook("prompt", (event) => {
      const session = sessionOf(event);
      if (session) emit(tracker.message(session, Date.now(), base));
    });
    const events = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: events.signal })) {
        const observation = tracker.settle({ type: event.type, properties: event.data }, Date.now());
        if (observation) emit([observation]);
      }
    })().catch(() => undefined);
    return () => {
      events.abort();
      void spool.flush().then(() => spool.dispose()).catch(() => undefined);
    };
  },
};

export default plugin;
