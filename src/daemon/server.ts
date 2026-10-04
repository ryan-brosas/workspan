/**
 * The daemon: one socket, one writer, one status file. It serves the CLI and the
 * desktop plugin, and it is the only process that opens the database.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect, type Server } from "node:net";
import { dirname } from "node:path";
import { drainOrphanedSpools, spoolHealth } from "../spool.ts";
import { createBackup, MAX_BACKUP_KEEP } from "./backup.ts";
import { buildReport, formatReport } from "./report.ts";
import { createReportPager } from "./report-pages.ts";
import { AutomaticClock } from "../core/clock.ts";
import { encodeFrame, fail, ok, parseRequest, PROTOCOL_VERSION, MAX_FRAME_BYTES, ProtocolError, type Response } from "../protocol.ts";
import { validateEvent, type EvidenceEvent } from "./evidence.ts";
import { SCHEMA_VERSION, WorkspanStore, sessionKey, type IngestResult, type SessionRow } from "./db.ts";
import { buildStatus, coveringSession, idleStretches, scopeFor, type DeliveryStatus, type HarnessReaderStatus, type HarnessStatus, type Status, type StatusCache } from "./measures.ts";
import { dayBounds, CalendarError } from "./calendar.ts";
import { localDayKey } from "../core/ledger.ts";
import { engineInfo, probeEngine } from "./engine.ts";
import { collectHarness } from "../adapters/registry.ts";
import type { HarnessReader } from "../adapters/harness.ts";
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
  /** Default beside this database, so a scratch daemon never consumes live spools. */
  spoolDir?: string;
  /**
   * Automatic harness detection: every pass probes each local agent history,
   * imports what it finds and reports both in the status file. Off unless asked:
   * the daemon entry point enables it, while an embedded or scratch daemon must
   * never read the user's harness histories or import them into its own database.
   * Any value above zero is clamped to a 1000 ms floor; a non-finite value is off.
   */
  harnessPollMs?: number;
  /**
   * How far back an automatic pass re-reads, clamped to a 60 000 ms floor and
   * defaulting to 7 days. Replay is safe, so overlap is free.
   */
  harnessWindowMs?: number;
  /** Reader override, so a test can drive the pass without a real harness store. */
  harnessReaders?: HarnessReader[];
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
  const spoolDir = options.spoolDir ?? dirname(store.path);

  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  if (await socketIsLive(socketFile)) throw new Error(`another Workspan daemon is already listening on ${socketFile}`);
  if (existsSync(socketFile)) rmSync(socketFile, { force: true });

  /** One clock per (project, session); its policy is core/clock.ts, restored from stored windows. */
  const clocks = new Map<string, AutomaticClock>();
  const clockFor = (event: EvidenceEvent) => {
    const scope = scopeFor(event, event.session);
    const key = JSON.stringify(scope);
    let clock = clocks.get(key);
    if (!clock) { clock = new AutomaticClock(store, scope, scope.sessionId, scope.task, idleGapMs); clocks.set(key, clock); }
    return clock;
  };

  const engine = engineInfo();
  const finite = (value: number | undefined, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
  // Automatic harness detection is enabled by the entry point, never implied for an
  // embedded daemon: a scratch database must not consume the user's live histories.
  // The first pass runs with the daemon, so a restart re-detects every store
  // instead of waiting a full interval. Math.max would propagate NaN, so every
  // non-finite option falls back to a real value instead of disabling detection.
  const requestedPollMs = options.harnessPollMs;
  const harnessPollMs = requestedPollMs === undefined || !Number.isFinite(requestedPollMs) || requestedPollMs <= 0 ? 0 : Math.max(1_000, requestedPollMs);
  const harnessWindowMs = Math.max(60_000, finite(options.harnessWindowMs, 7 * 86_400_000));
  let harnessStatus: HarnessStatus = {
    interval_ms: harnessPollMs, window_ms: harnessWindowMs,
    polled_at: null, took_ms: null, error: null, readers: [],
  };
  // The projection is held against a watermark, so a periodic refresh pays for a Bend
  // union only when the evidence actually changed.
  const projection: StatusCache = {};
  let cached: Status | null = null;
  let lastDrainError: string | null = null;
  const refresh = (): Status => {
    const at = now();
    // The day bounds are what turns the cached intervals into a review list; they are
    // recomputed on every write, so a status file cannot carry yesterday's day.
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const day = dayBounds(localDayKey(at, timezone), timezone);
    // One listing for the pending numbers and the refusal markers: a refresh runs on
    // every heartbeat and every accepted batch, so a large backlog is never walked twice.
    const health = spoolHealth(spoolDir);
    const pending = health.files.filter(file => file.bytes > 0);
    const delivery: DeliveryStatus = { pending_files: pending.length, pending_bytes: pending.reduce((sum, file) => sum + file.bytes, 0), issues: health.problems.length, error: lastDrainError };
    // Status assembly has one owner: the transport and detection snapshots go in here
    // rather than being attached to the result afterwards.
    const status = buildStatus(store, { idleGapMs, now: at, engine, cache: projection, day, delivery, harness: harnessStatus });
    cached = status;
    const tmp = `${statusFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(status, null, 2) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, statusFile);
    return status;
  };
  const current = (): Status => cached ?? refresh();
  const pageReport = createReportPager(query => buildReport(store, { ...query, now: now(), idleGapMs, engine, cache: projection, delivery: current().delivery }));

  /**
   * One event through the only writer. Attribution is resolved here, not in the
   * adapter: an adapter that named a client would be guessing it. The root travels
   * with the evidence so a confirmed binding can re-attribute later.
   */
  const ingestEvent = (event: EvidenceEvent): IngestResult & { at: number } => {
    const human = event.kind === "interaction" && event.origin === "human";
    const resolved = event.project ?? (event.root ? store.resolveProject(event.root) : undefined);
    const attributed: EvidenceEvent = resolved !== undefined ? { ...event, project: resolved } : event;
    return { ...store.ingest(attributed, now(), e => { if (human) clockFor(e).touch(e.at); }), at: event.at };
  };

  /**
   * A conflict changes what the report must show, so it invalidates the projection
   * too — not only a newly accepted observation. Duplicates change nothing.
   */
  const settle = (receipts: Array<IngestResult & { at: number }>): Array<IngestResult & { at: number }> => {
    // The evidence is durable by now: a failed status write must not turn a committed
    // ingest into a client-visible failure that invites a pointless resend.
    if (receipts.some(r => r.status !== "duplicate")) { try { refresh(); } catch { /* health remains on disk */ } }
    return receipts;
  };

  const ingestAll = (params: unknown) => {
    const list = (params as { events?: unknown })?.events;
    if (!Array.isArray(list)) throw new ProtocolError("bad_request", "ingest needs an events array");
    if (list.length > 5000) throw new ProtocolError("too_many_events", "ingest accepts at most 5000 events per frame");
    // Validate the whole frame before the first write: a bad record late in a frame must
    // not leave earlier events committed with no receipts and no status refresh. A
    // rejection names the offending slot and a bounded cause, because the client is the
    // side that retains evidence for review.
    const events = list.map((raw, index) => {
      try { return validateEvent(raw); }
      catch (error) { throw new ProtocolError("bad_event", `event ${index} failed validation: ${bounded(error)}`); }
    });
    const receipts = events.map(ingestEvent);
    settle(receipts);
    return {
      accepted: receipts.filter(r => r.status === "accepted").length,
      duplicates: receipts.filter(r => r.status === "duplicate").length,
      conflicts: receipts.filter(r => r.status === "conflict").length,
      receipts,
    };
  };

  /**
   * One automatic pass: probe every reader, import what it found, and record what
   * happened per reader. A missing store is unavailable, never zero; a reader that
   * fails is named and never hides the others. Replay is safe, so a repeated pass
   * over the same evidence adds nothing and reports that as duplicates.
   */
  const MAX_PASS_EVENTS = 5_000;
  const OVERLAP_MS = 86_400_000;
  let lastPassStartedAt: number | null = null;
  const scanHarness = (): void => {
    const started = now();
    const momentOf = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
    const textOf = (value: unknown): string | null => (typeof value === "string" ? value : null);
    // Steady-state passes read only what appeared since the last pass, with a day of
    // overlap for a store that flushes late; the full window is re-read on the first
    // pass, and after any failed or bounded pass, where re-importing is the point.
    const sinceMs = lastPassStartedAt === null ? started - harnessWindowMs : Math.max(started - harnessWindowMs, lastPassStartedAt - Math.min(harnessWindowMs, OVERLAP_MS));
    try {
      const collected = collectHarness({
        sinceMs,
        now: started,
        ...(options.harnessReaders ? { readers: options.harnessReaders } : {}),
      });
      let deferred = false;
      const readers: HarnessReaderStatus[] = collected.map(entry => {
        let error = textOf(entry.summary.error);
        // One reader must never take the whole pass down, and an unbounded first pass
        // must not block the event loop: the remainder arrives on the next pass.
        const events = entry.events.slice(0, MAX_PASS_EVENTS);
        if (entry.events.length > events.length) { deferred = true; error = `${error ? `${error}; ` : ""}pass bounded: ${entry.events.length - events.length} record(s) deferred to the next pass`; }
        let receipts: Array<IngestResult & { at: number }> = [];
        try { receipts = events.map(ingestEvent); }
        catch (failure) { error = `${error ? `${error}; ` : ""}ingest failed: ${bounded(failure)}`; }
        return {
          id: entry.id,
          source: entry.source,
          store: textOf(entry.summary.store),
          available: typeof entry.summary.store === "string",
          last_event_at: momentOf(entry.summary.lastEventAt),
          stale_days: momentOf(entry.summary.staleDays),
          events: events.length,
          accepted: receipts.filter(r => r.status === "accepted").length,
          duplicates: receipts.filter(r => r.status === "duplicate").length,
          conflicts: receipts.filter(r => r.status === "conflict").length,
          error,
        };
      });
      harnessStatus = { ...harnessStatus, polled_at: started, took_ms: Math.max(0, now() - started), error: null, readers };
      if (!deferred) lastPassStartedAt = started;
    } catch (error) {
      // A pass that failed before any reader reported is stated, never smoothed
      // into "nothing found".
      harnessStatus = { ...harnessStatus, polled_at: started, took_ms: Math.max(0, now() - started), error: bounded(error) };
    }
    // The pass timestamp is the loop's own liveness signal: write it even when every
    // record in the pass was a duplicate, so a healthy quiet scan is not "stale".
    try { refresh(); } catch { /* health remains on disk */ }
  };

  /**
   * An explicit project wins. Otherwise a workspace root resolves through the
   * bindings - the same rule evidence follows - so a manual hit attributes to
   * wherever the user is actually working instead of a hard-coded client.
   */
  const sessionChoice = (params: unknown): { project?: string; root?: string } => {
    const value = (params ?? {}) as { project?: unknown; root?: unknown };
    const root = typeof value.root === "string" && value.root ? value.root : undefined;
    const explicit = typeof value.project === "string" && value.project ? value.project : undefined;
    const project = explicit ?? (root ? store.resolveProject(root) : undefined);
    return { ...(project ? { project } : {}), ...(root ? { root } : {}) };
  };

  const manualEvent = (choice: { kind: "session-start" | "session-stop" | "session-pause" | "session-resume"; session?: string; project?: string; root?: string }, at: number): EvidenceEvent => {
    return validateEvent({
      v: 1, source: "manual", instance: "cli",
      session: choice.session ?? `s-${at}`,
      event: `${choice.kind}-${at}-${Math.random().toString(36).slice(2, 10)}`,
      kind: choice.kind, at, origin: "attested",
      ...(choice.project ? { project: choice.project } : {}),
      ...(choice.root ? { root: choice.root } : {}),
    });
  };

  /**
   * The moment a session command is about: the caller's stated `at`, or now. A stated
   * moment is a correction - the ledger keeps both the claim and the receipt, and the
   * day report says the entry was recorded later - so it may never be in the future.
   */
  const moment = (params: unknown): { at: number; recordedAt: number; stated: boolean } => {
    const recordedAt = now();
    const value = (params ?? {}) as { at?: unknown };
    if (value.at === undefined) return { at: recordedAt, recordedAt, stated: false };
    if (!Number.isSafeInteger(value.at) || (value.at as number) <= 0) throw new ProtocolError("bad_request", "at must be integer epoch milliseconds");
    const at = value.at as number;
    if (at > recordedAt) throw new ProtocolError("bad_request", "a session event cannot be recorded in the future");
    return { at, recordedAt, stated: true };
  };

  const rowFor = (value: string): SessionRow | null =>
    store.sessionRows().find(candidate => candidate.id === store.sessionKeyFromValue(value)) ?? null;

  const handle = (method: string, id: string, params: unknown): Response => {
    switch (method) {
      case "health":
        return ok(id, { state: "ok", schema: SCHEMA_VERSION, protocol: PROTOCOL_VERSION, socket: socketFile, status_file: statusFile, database: store.path });
      case "status":
        return ok(id, current());
      case "projects":
        return ok(id, { bindings: store.projectBindings() });
      case "projects.bind": {
        // Confirming a binding is an explicit action: it decides where future hours
        // land, so it is never guessed and never silent.
        const value = (params ?? {}) as { root?: unknown; project?: unknown; explicit?: unknown };
        const root = typeof value.root === "string" ? value.root.trim() : "";
        const project = typeof value.project === "string" ? value.project.trim() : "";
        if (!root || !project) throw new ProtocolError("bad_request", "bind needs a root and a project");
        store.bindProject(root, project, value.explicit === true, "cli");
        refresh();
        return ok(id, { bindings: store.projectBindings() });
      }
      case "engine":
        // The accounting engine, and a live probe through the same call path the
        // measures use, so the numbers are never taken on trust.
        return ok(id, { engine, check: probeEngine() });
      case "ingest":
        return ok(id, ingestAll(params));
      case "session.start": {
        if (store.openSession()) throw new ProtocolError("session_open", "a session is already running; stop it or use session.switch");
        const when = moment(params);
        const choice = sessionChoice(params);
        const event = manualEvent({ kind: "session-start", ...choice }, when.at);
        const receipt = store.ingest(event, when.recordedAt);
        refresh();
        // `session` is the value the caller passes to the other session commands;
        // `key` is the internal identity, for diagnostics only.
        return ok(id, {
          receipt, session: event.session, key: sessionKey(event), project: event.project ?? null, root: event.root ?? null,
          started_at: when.at,
          ...(when.stated ? { corrected: true, recorded_at: when.recordedAt } : {}),
        });
      }
      case "session.pause": {
        const open = store.openSession();
        if (!open) throw new ProtocolError("no_open_session", "nothing is running");
        if (open.state === "paused") return ok(id, { session: open.session, state: "paused", unchanged: true });
        const when = moment(params);
        if (when.at < open.startedAt) throw new ProtocolError("bad_request", "a pause cannot be recorded before the session started");
        const receipt = store.ingest(manualEvent({ kind: "session-pause", session: open.session }, when.at), when.recordedAt);
        refresh();
        return ok(id, { receipt, session: open.session, state: "paused", ...(when.stated ? { corrected: true, recorded_at: when.recordedAt } : {}) });
      }
      case "session.resume": {
        const open = store.openSession();
        if (!open) throw new ProtocolError("no_open_session", "nothing is running");
        if (open.state === "running") return ok(id, { session: open.session, state: "running", unchanged: true });
        const when = moment(params);
        if (when.at < open.startedAt) throw new ProtocolError("bad_request", "a resume cannot be recorded before the session started");
        const receipt = store.ingest(manualEvent({ kind: "session-resume", session: open.session }, when.at), when.recordedAt);
        refresh();
        return ok(id, { receipt, session: open.session, state: "running", ...(when.stated ? { corrected: true, recorded_at: when.recordedAt } : {}) });
      }
      case "session.note": {
        const value = (params ?? {}) as { note?: unknown; session?: unknown; idle?: unknown };
        if (typeof value.note !== "string") throw new ProtocolError("bad_request", "a note needs text");
        const asked = typeof value.session === "string" && value.session ? value.session : null;
        let target: SessionRow | null = null;
        let idle: { from: number; to: number } | null = null;
        if (value.idle === true) {
          // The nudge's follow-up: the note belongs to the session the seat-idle
          // stretch happened in, never to whatever happens to be open now.
          const finished = idleStretches(store.observations()).filter(stretch => stretch.to !== null);
          const stretch = finished.length ? finished[finished.length - 1] : null;
          if (!stretch || stretch.to === null) throw new ProtocolError("no_idle_stretch", "no finished seat-idle stretch is on record");
          idle = { from: stretch.from, to: stretch.to };
          target = coveringSession(store.sessionRows(), stretch.from);
          if (!target) throw new ProtocolError("no_covering_session", "no attested session covers that stretch; list them with: workspan session list");
        } else if (asked !== null) {
          target = rowFor(asked);
          if (!target) throw new ProtocolError("no_such_session", `no session ${asked}`);
        } else {
          target = store.openSession();
          if (!target) throw new ProtocolError("no_open_session", "nothing is running");
        }
        if (target.removedAt !== null) throw new ProtocolError("session_removed", "that session was removed as a correction");
        const note = store.addSessionNote(target.id, value.note, now());
        // A note changes no measure, so the projection stays valid: no refresh.
        return ok(id, { note, session: target.session, project: target.project, ...(idle ? { idle } : {}) });
      }
      case "session.stop": {
        const open = store.openSession();
        const value = (params ?? {}) as { session?: unknown; note?: unknown };
        const session = typeof value.session === "string" && value.session ? value.session : open?.session;
        if (!session) throw new ProtocolError("no_open_session", "nothing is running");
        // A stop for a session that does not exist must be an error, not a silent no-op.
        const row = rowFor(session);
        if (!row) throw new ProtocolError("no_such_session", `no session ${session}`);
        if (row.removedAt !== null) throw new ProtocolError("session_removed", "that session was removed as a correction");
        const when = moment(params);
        if (when.at < row.startedAt) throw new ProtocolError("bad_request", "a stop cannot be recorded before the session started");
        // The stop note lands first so the session still exists to attach it to.
        const note = typeof value.note === "string" ? store.addSessionNote(row.id, value.note, when.recordedAt) : null;
        const event = manualEvent({ kind: "session-stop", session }, when.at);
        const receipt = store.ingest(event, when.recordedAt);
        refresh();
        return ok(id, {
          receipt, session, key: sessionKey(event), ...(note ? { note } : {}),
          stopped_at: when.at,
          ...(when.stated ? { corrected: true, recorded_at: when.recordedAt } : {}),
        });
      }
      case "session.remove": {
        const value = (params ?? {}) as { session?: unknown; reason?: unknown };
        const key = typeof value.session === "string" && value.session ? value.session : "";
        if (!key) throw new ProtocolError("bad_request", "removal needs a session");
        if (typeof value.reason !== "string") throw new ProtocolError("bad_request", "removal needs a reason");
        const at = now();
        try {
          const removed = store.removeSession(key, value.reason, at);
          refresh();
          return ok(id, { removed: true, session: removed.row.session, project: removed.row.project, reason: removed.row.removedReason, ...(removed.alreadyRemoved ? { alreadyRemoved: true } : {}) });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const code = message.includes("no such session") ? "no_such_session"
            : message.includes("only be removed once it is stopped") ? "session_open"
            : "bad_request";
          throw new ProtocolError(code, message);
        }
      }
      case "session.list": {
        const rows = store.sessionRows();
        return ok(id, { sessions: rows.map(row => ({
          session: row.session, project: row.project, root: row.root,
          startedAt: row.startedAt, endedAt: row.endedAt, state: row.state,
          removedAt: row.removedAt, removedReason: row.removedReason,
        })) });
      }
      case "session.toggle": {
        // One command for a keybinding or a menu row: start when nothing is open,
        // stop when something is. Idempotent in both directions.
        const open = store.openSession();
        const at = now();
        if (open) {
          const receipt = store.ingest(manualEvent({ kind: "session-stop", session: open.session }, at), at);
          refresh();
          return ok(id, { receipt, action: "stopped", session: open.session });
        }
        const choice = sessionChoice(params);
        const event = manualEvent({ kind: "session-start", ...choice }, at);
        const receipt = store.ingest(event, at);
        refresh();
        return ok(id, { receipt, action: "started", session: event.session, project: event.project ?? null, root: event.root ?? null });
      }
      case "session.switch": {
        // One call closes the old segment and opens the new one at the same instant:
        // no hour is counted twice, and none is lost in between.
        const at = now();
        const choice = sessionChoice(params);
        const open = store.openSession();
        const events = [
          ...(open ? [manualEvent({ kind: "session-stop", session: open.session }, at)] : []),
          manualEvent({ kind: "session-start", session: `s-${at}`, ...choice }, at),
        ];
        const receipts = events.map(event => store.ingest(event, at));
        refresh();
        return ok(id, { receipts, closed: open ? open.session : null, session: `s-${at}`, project: choice.project ?? null, root: choice.root ?? null });
      }
      case "backup": {
        const value = (params ?? {}) as { keep?: unknown };
        if (value.keep !== undefined && (typeof value.keep !== "number" || !Number.isSafeInteger(value.keep) || value.keep < 1 || value.keep > MAX_BACKUP_KEEP)) throw new ProtocolError("bad_request", `keep must be an integer from 1 to ${MAX_BACKUP_KEEP}`);
        return ok(id, createBackup(store, { keep: value.keep as number | undefined, now: now() }));
      }
      case "day": {
        // Only the documented parameters are read, and only when they are non-empty
        // strings: a type-confused or unknown value is ignored here instead of reaching
        // the calendar as an internal error or leaking into the report options.
        const value = (params ?? {}) as { date?: unknown; timezone?: unknown };
        const date = typeof value.date === "string" && value.date ? value.date : undefined;
        const timezone = typeof value.timezone === "string" && value.timezone ? value.timezone : undefined;
        const facts = buildReport(store, { period: "day", ...(date ? { date } : {}), ...(timezone ? { timezone } : {}), now: now(), idleGapMs, engine, cache: projection, delivery: current().delivery });
        return ok(id, { date: facts.date, timezone: facts.timezone, text: formatReport(facts, "text") });
      }
      case "report": return ok(id, pageReport(params));
      default:
        throw new ProtocolError("unknown_method", `unknown method ${JSON.stringify(method)}`);
    }
  };

  const server: Server = createServer(socket => {
    let buffer = "", closed = false;
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      if (closed) return;
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
          const code = error instanceof ProtocolError ? error.code : error instanceof CalendarError ? "bad_request" : "internal";
          response = fail(id, code, error instanceof ProtocolError || error instanceof CalendarError ? error.message : `request failed: ${bounded(error)}`);
        }
        let output = encodeFrame(response);
        if (Buffer.byteLength(output) > MAX_FRAME_BYTES) {
          // The refusal must not echo an id large enough to exceed the limit it is
          // protecting: a request is legal up to MAX_FRAME_BYTES, id included.
          const echoed = id.length > 64 ? "" : id;
          const fallback = encodeFrame(fail(echoed, "response_too_large", "response exceeds frame limit; use the paged report method for reports"));
          output = Buffer.byteLength(fallback) > MAX_FRAME_BYTES ? encodeFrame(fail("", "response_too_large", "response exceeds frame limit")) : fallback;
        }
        socket.write(output);
      }
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
        // Stop reading and parsing: the rest of the oversized frame is still in flight,
        // and a second end() would only race the refusal out of the socket.
        closed = true;
        buffer = "";
        socket.end(encodeFrame(fail("", "frame_too_large", "frame exceeds limit")));
      }
    });
    socket.on("error", () => socket.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketFile, () => { chmodSync(socketFile, 0o600); resolve(); });
  });
  refresh();

  // Detection runs with the daemon and on its own interval: no harness needs a
  // per-harness installation, and a restart re-imports what the last pass missed.
  // The first pass is the same function the timer calls.
  // The first pass is deferred: it reads local histories synchronously, so a client
  // that connects during startup must not wait behind it.
  if (harnessPollMs > 0) setImmediate(scanHarness);
  const harnessTimer = harnessPollMs > 0 ? setInterval(scanHarness, harnessPollMs) : null;
  harnessTimer?.unref?.();

  const statusIntervalMs = Math.max(1_000, options.statusIntervalMs ?? 15_000);
  let recovery: Promise<void> | null = null;
  const recover = () => {
    if (recovery) return;
    // Promise.resolve() first so a synchronous throw can never escape the heartbeat,
    // and the failure is kept for status instead of vanishing: a queue that never
    // shrinks without a named cause is not diagnosable.
    recovery = Promise.resolve()
      .then(() => drainOrphanedSpools({ directory: spoolDir, socketPath: socketFile }))
      .then(() => { lastDrainError = null; })
      .catch(error => { lastDrainError = bounded(error); })
      .then(() => { try { refresh(); } catch { /* health remains on disk */ } })
      .finally(() => { recovery = null; });
  };
  recover();
  const heartbeat = setInterval(() => {
    try { refresh(); } catch { /* a failed status write must not stop recovery */ }
    recover();
  }, statusIntervalMs);
  heartbeat.unref?.();

  return {
    socketPath: socketFile,
    statusPath: statusFile,
    status: current,
    close: async () => {
      clearInterval(heartbeat);
      if (harnessTimer) clearInterval(harnessTimer);
      // A drain talks to this daemon's own socket, the same call the live probe bounds
      // with a timeout, so a stalled connect must not hold shutdown open forever.
      if (recovery) await Promise.race([recovery.catch(() => undefined), new Promise<void>(resolve => { const timer = setTimeout(resolve, 5_000); timer.unref?.(); })]);
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(socketFile, { force: true });
      store.close();
    },
  };
}

/** Read the materialized status without a socket, for tests and diagnostics. */
export function readStatusFile(runtimeDir: string): Status { return JSON.parse(readFileSync(statusPath(runtimeDir), "utf8")) as Status; }
