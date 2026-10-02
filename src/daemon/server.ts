/**
 * The daemon: one socket, one writer, one status file. It serves the CLI and the
 * desktop plugin, and it is the only process that opens the database.
 */
import { createServer, connect, type Server } from "node:net";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { AutomaticClock } from "../core/clock.ts";
import { encodeFrame, fail, ok, parseRequest, PROTOCOL_VERSION, ProtocolError, type Response } from "../protocol.ts";
import { validateEvent, type EvidenceEvent } from "./evidence.ts";
import { SCHEMA_VERSION, WorkspanStore, sessionKey, type IngestResult } from "./db.ts";
import { buildStatus, scopeFor, type Status } from "./measures.ts";
import { engineInfo, probeEngine } from "./engine.ts";
import { socketPath as socketPathFor, statusPath } from "./paths.ts";

const MAX_ERROR_CHARS = 200;
const bounded = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS)}…` : message;
};

export interface DaemonOptions {
  store: WorkspanStore;
  runtimeDir: string;
  idleGapMs?: number;
  now?: () => number;
  /**
   * How often the status file is re-materialized even when nothing changed. The
   * file doubles as a liveness signal: without this, a quiet tracker reads as
   * offline after a minute and an open session's provisional time stops ticking.
   */
  statusIntervalMs?: number;
}
export interface Daemon { socketPath: string; statusPath: string; status(): Status; close(): Promise<void> }

/** Refuse to clobber a live daemon: only unlink a socket nobody answers on. */
async function socketIsLive(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  return await new Promise<boolean>(resolve => {
    const probe = connect(path);
    const done = (live: boolean) => { probe.destroy(); resolve(live); };
    probe.setTimeout(300);
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
    probe.once("timeout", () => done(false));
  });
}

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const { store, runtimeDir } = options;
  const idleGapMs = options.idleGapMs ?? 15 * 60_000;
  const now = options.now ?? (() => Date.now());
  const socketFile = socketPathFor(runtimeDir);
  const statusFile = statusPath(runtimeDir);

  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  if (await socketIsLive(socketFile)) throw new Error(`another Workspan daemon is already listening on ${socketFile}`);
  if (existsSync(socketFile)) rmSync(socketFile, { force: true });

  /** One clock per (project, session); its policy is core/clock.ts, restored from stored windows. */
  const clocks = new Map<string, AutomaticClock>();
  const clockFor = (event: EvidenceEvent) => {
    const scope = scopeFor(event.project, event.session);
    const key = JSON.stringify(scope);
    let clock = clocks.get(key);
    if (!clock) { clock = new AutomaticClock(store, scope, scope.sessionId, scope.task, idleGapMs); clocks.set(key, clock); }
    return clock;
  };

  const engine = engineInfo();
  let cached: Status | null = null;
  const refresh = (): Status => {
    const status = buildStatus(store, { idleGapMs, now: now(), engine });
    cached = status;
    const tmp = `${statusFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(status, null, 2) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, statusFile);
    return status;
  };
  const current = (): Status => cached ?? refresh();

  const ingestAll = (params: unknown) => {
    const list = (params as { events?: unknown })?.events;
    if (!Array.isArray(list)) throw new ProtocolError("bad_request", "ingest needs an events array");
    if (list.length > 5000) throw new ProtocolError("too_many_events", "ingest accepts at most 5000 events per frame");
    const receipts: Array<IngestResult & { at: number }> = [];
    for (const raw of list) {
      const event = validateEvent(raw);
      const human = event.kind === "interaction" && event.origin === "human";
      receipts.push({ ...store.ingest(event, now(), e => { if (human) clockFor(e).touch(e.at); }), at: event.at });
    }
    // A conflict changes what the report must show, so it invalidates the
    // projection too — not only a newly accepted observation.
    if (receipts.some(r => r.status !== "duplicate")) refresh();
    return {
      accepted: receipts.filter(r => r.status === "accepted").length,
      duplicates: receipts.filter(r => r.status === "duplicate").length,
      conflicts: receipts.filter(r => r.status === "conflict").length,
      receipts,
    };
  };

  const manualEvent = (params: unknown, kind: "session-start" | "session-stop"): EvidenceEvent => {
    const value = (params ?? {}) as { project?: unknown; session?: unknown; task?: unknown };
    const at = now();
    return validateEvent({
      v: 1, source: "manual", instance: "cli",
      session: typeof value.session === "string" && value.session ? value.session : `s-${at}`,
      event: `${kind}-${at}-${Math.random().toString(36).slice(2, 10)}`,
      kind, at, origin: "attested",
      project: typeof value.project === "string" && value.project ? value.project : undefined,
    });
  };

  const handle = (method: string, id: string, params: unknown): Response => {
    switch (method) {
      case "health":
        return ok(id, { state: "ok", schema: SCHEMA_VERSION, protocol: PROTOCOL_VERSION, socket: socketFile, status_file: statusFile, database: store.path });
      case "status":
        return ok(id, current());
      case "projects":
        return ok(id, { bindings: store.projectBindings() });
      case "engine":
        // The accounting engine, and a live probe through the same call path the
        // measures use, so the numbers are never taken on trust.
        return ok(id, { engine, check: probeEngine() });
      case "ingest":
        return ok(id, ingestAll(params));
      case "session.start": {
        const event = manualEvent(params, "session-start");
        const receipt = store.ingest(event, now());
        refresh();
        // `session` is the value the caller passes back to session.stop; `key` is
        // the internal identity, returned for diagnostics only.
        return ok(id, { receipt, session: event.session, key: sessionKey(event), project: event.project ?? null, started_at: event.at });
      }
      case "session.stop": {
        const event = manualEvent(params, "session-stop");
        const receipt = store.ingest(event, now());
        refresh();
        return ok(id, { receipt, session: event.session, key: sessionKey(event) });
      }
      default:
        throw new ProtocolError("unknown_method", `unknown method ${JSON.stringify(method)}`);
    }
  };

  const server: Server = createServer(socket => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let response: Response;
        let id = "";
        try {
          const request = parseRequest(line);
          id = request.id;
          response = handle(request.method, request.id, request.params);
        } catch (error) {
          const code = error instanceof ProtocolError ? error.code : "internal";
          response = fail(id, code, error instanceof ProtocolError ? error.message : `request failed: ${bounded(error)}`);
        }
        socket.write(encodeFrame(response));
      }
    });
    socket.on("error", () => socket.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketFile, () => { chmodSync(socketFile, 0o600); resolve(); });
  });
  refresh();

  const statusIntervalMs = Math.max(1_000, options.statusIntervalMs ?? 15_000);
  const heartbeat = setInterval(() => { try { refresh(); } catch { /* a failed tick must not kill the daemon */ } }, statusIntervalMs);
  heartbeat.unref?.();

  return {
    socketPath: socketFile,
    statusPath: statusFile,
    status: current,
    close: async () => {
      clearInterval(heartbeat);
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(socketFile, { force: true });
      store.close();
    },
  };
}

/** Read the materialized status without a socket, for tests and diagnostics. */
export function readStatusFile(runtimeDir: string): Status { return JSON.parse(readFileSync(statusPath(runtimeDir), "utf8")) as Status; }
