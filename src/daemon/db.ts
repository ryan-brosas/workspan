/**
 * The single durable authority. One writer: the daemon. Everything is keyed by
 * source event identity, so replay is safe and a changed payload is a visible
 * conflict rather than a silent overwrite.
 */
import { DatabaseSync } from "node:sqlite";
import { constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ClockWindow, WindowPort } from "../core/clock.ts";
import { eventId, fingerprint, type EvidenceEvent, type Kind, type Origin } from "./evidence.ts";

export const SCHEMA_VERSION = 1;

export interface Observation extends EvidenceEvent { eventId: string; receivedAt: number }
export interface SessionRow { id: string; session: string; project: string | null; startedAt: number; endedAt: number | null; state: "running" | "stopped" }
export interface ConflictRow { eventId: string; reason: string; detectedAt: number }
export interface SourceHealth { source: string; events: number; cursor: number }
export interface ProjectBinding { root: string; project: string; explicit: boolean; source: string }

export type IngestResult =
  | { status: "accepted"; eventId: string }
  | { status: "duplicate"; eventId: string }
  | { status: "conflict"; eventId: string };

const SCHEMA = `
create table if not exists meta (key text primary key, value text not null);
create table if not exists observations (
  event_id text primary key, source text not null, instance text not null, session text not null, event text not null,
  kind text not null, at integer not null, origin text not null, project text, fingerprint text not null, received_at integer not null
);
create index if not exists observations_at on observations(at);
create table if not exists conflicts (
  event_id text primary key, reason text not null, first_fingerprint text not null, seen_fingerprint text not null, detected_at integer not null
);
create table if not exists sessions (
  id text primary key, source_session text not null, project text, started_at integer not null, ended_at integer, state text not null
);
create table if not exists windows (
  id text primary key, root text not null, client text not null, session_id text not null,
  task text not null, start integer not null, end integer not null, kind text not null
);
create index if not exists windows_lookup on windows(root, session_id, end);
create table if not exists source_state (source text primary key, events integer not null, cursor integer not null, updated_at integer not null);
create table if not exists project_bindings (
  root text primary key, project text not null, explicit integer not null default 0, source text not null, updated_at integer not null
);
`;

export class WorkspanStore implements WindowPort {
  private db: DatabaseSync;
  private closed = false;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Workspan database must not be a symlink");
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile()) throw new Error("Workspan database must be a regular file");
      fchmodSync(fd, 0o600);
    } finally { closeSync(fd); }
    this.db = new DatabaseSync(path);
    this.db.exec("pragma journal_mode = wal");
    this.db.exec("pragma synchronous = full");
    this.db.exec(SCHEMA);
    this.db.prepare("insert or ignore into meta(key, value) values('schema_version', ?)").run(String(SCHEMA_VERSION));
  }

  /**
   * Monotonic evidence revision. Every mutation that can change a projection bumps
   * it, so a derived view can be reused until the evidence actually moves.
   */
  revision(): number {
    const row = this.db.prepare("select value from meta where key = 'revision'").get() as { value: string } | undefined;
    return Number(row?.value ?? 0);
  }
  private bumpRevision(): void {
    this.db.prepare("insert into meta(key, value) values('revision', '1') on conflict(key) do update set value = cast(cast(value as integer) + 1 as text)").run();
  }

  /**
   * Accept one observation. Identity decides: an identical replay returns the
   * previous receipt, changed metadata under one identity is recorded as a
   * conflict and leaves the stored observation untouched.
   */
  ingest(event: EvidenceEvent, receivedAt = Date.now(), effect?: (event: EvidenceEvent) => void): IngestResult {
    const id = eventId(event);
    const print = fingerprint(event);
    const existing = this.db.prepare("select fingerprint from observations where event_id = ?").get(id) as { fingerprint: string } | undefined;
    if (existing) {
      if (existing.fingerprint === print) return { status: "duplicate", eventId: id };
      this.db.exec("begin immediate");
      try {
        this.db.prepare("insert or replace into conflicts(event_id, reason, first_fingerprint, seen_fingerprint, detected_at) values(?,?,?,?,?)")
          .run(id, "metadata_changed", existing.fingerprint, print, receivedAt);
        this.bumpRevision();
        this.db.exec("commit");
      } catch (error) { this.db.exec("rollback"); throw error; }
      return { status: "conflict", eventId: id };
    }
    this.db.exec("begin immediate");
    try {
      this.db.prepare("insert into observations(event_id, source, instance, session, event, kind, at, origin, project, fingerprint, received_at) values(?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, event.source, event.instance, event.session, event.event, event.kind, event.at, event.origin, event.project ?? null, print, receivedAt);
      this.bumpSource(event.source, event.at, receivedAt);
      this.applyEffect(event);
      // The clock writes through this same connection, so an accepted
      // observation and the window it produces commit together.
      effect?.(event);
      this.bumpRevision();
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
    return { status: "accepted", eventId: id };
  }

  /** Session transitions and inferred-window evidence are effects of accepted observations. */
  private applyEffect(event: EvidenceEvent): void {
    if (event.kind === "session-start") {
      const id = sessionKey(event);
      const row = this.db.prepare("select started_at from sessions where id = ?").get(id) as { started_at: number } | undefined;
      if (!row) this.db.prepare("insert into sessions(id, source_session, project, started_at, ended_at, state) values(?,?,?,?,null,'running')")
        .run(id, event.session, event.project ?? null, event.at);
      return;
    }
    if (event.kind === "session-stop") {
      const id = sessionKey(event);
      const row = this.db.prepare("select started_at from sessions where id = ?").get(id) as { started_at: number } | undefined;
      if (row) this.db.prepare("update sessions set ended_at = ?, state = 'stopped' where id = ?").run(event.at, id);
      return;
    }
    // Inferred windows are not an effect of ingest: the daemon drives
    // core/clock.ts for human-origin interaction, so window policy has exactly
    // one implementation and this store stays a store.
  }

  private bumpSource(source: string, at: number, now: number): void {
    this.db.prepare(`insert into source_state(source, events, cursor, updated_at) values(?, 1, ?, ?)
      on conflict(source) do update set events = events + 1, cursor = max(cursor, excluded.cursor), updated_at = excluded.updated_at`)
      .run(source, at, now);
  }

  // WindowPort: the daemon's persistence side of core/clock.ts.
  latest(root: string, sessionId: string): ClockWindow | undefined {
    const row = this.db.prepare("select * from windows where root = ? and session_id = ? order by end desc, rowid desc limit 1").get(root, sessionId) as Record<string, unknown> | undefined;
    return row ? windowFromRow(row) : undefined;
  }
  save(window: ClockWindow): void {
    this.db.prepare("insert into windows(id, root, client, session_id, task, start, end, kind) values(?,?,?,?,?,?,?,?)\n      on conflict(id) do update set start = excluded.start, end = excluded.end, kind = excluded.kind")
      .run(window.id, window.root, window.client, window.sessionId, window.task, window.start, window.end, window.kind);
    this.bumpRevision();
  }

  observations(): Observation[] {
    return (this.db.prepare("select * from observations order by at asc, rowid asc").all() as Record<string, unknown>[]).map(row => ({
      eventId: String(row.event_id), source: String(row.source) as Observation["source"], instance: String(row.instance),
      session: String(row.session), event: String(row.event), kind: String(row.kind) as Kind, at: Number(row.at),
      origin: String(row.origin) as Origin, project: row.project === null ? undefined : String(row.project),
      receivedAt: Number(row.received_at),
    }));
  }
  windows(): ClockWindow[] {
    return (this.db.prepare("select * from windows order by start asc, rowid asc").all() as Record<string, unknown>[]).map(windowFromRow);
  }
  sessionRows(): SessionRow[] {
    return (this.db.prepare("select * from sessions order by started_at asc").all() as Record<string, unknown>[]).map(row => ({
      id: String(row.id), session: String(row.source_session), project: row.project === null ? null : String(row.project),
      startedAt: Number(row.started_at), endedAt: row.ended_at === null ? null : Number(row.ended_at),
      state: String(row.state) as SessionRow["state"],
    }));
  }
  conflictRows(): ConflictRow[] {
    return (this.db.prepare("select * from conflicts order by detected_at asc").all() as Record<string, unknown>[]).map(row => ({
      eventId: String(row.event_id), reason: String(row.reason), detectedAt: Number(row.detected_at),
    }));
  }
  sources(): SourceHealth[] {
    return (this.db.prepare("select * from source_state order by source asc").all() as Record<string, unknown>[]).map(row => ({
      source: String(row.source), events: Number(row.events), cursor: Number(row.cursor),
    }));
  }
  /**
   * Root to project bindings. `explicit` records whether a person confirmed the
   * client or the label was derived from a directory name: an unconfirmed label is
   * reported as such instead of being presented as a client someone chose.
   */
  bindProject(root: string, project: string, explicit: boolean, source: string): void {
    this.db.prepare("insert into project_bindings(root, project, explicit, source, updated_at) values(?,?,?,?,?)\n      on conflict(root) do update set project = excluded.project, explicit = excluded.explicit, source = excluded.source, updated_at = excluded.updated_at")
      .run(root, project, explicit ? 1 : 0, source, Date.now());
    this.bumpRevision();
  }
  projectBindings(): ProjectBinding[] {
    return (this.db.prepare("select * from project_bindings order by project asc, root asc").all() as Record<string, unknown>[]).map(row => ({
      root: String(row.root), project: String(row.project), explicit: Number(row.explicit) === 1, source: String(row.source),
    }));
  }

  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
}

/**
 * A session key is handed back to clients and may travel through argv, so it is
 * printable and unambiguous: percent-encoded parts joined by "|".
 */
export function sessionKey(event: Pick<EvidenceEvent, "source" | "instance" | "session">): string {
  return [event.source, event.instance, event.session].map(part => encodeURIComponent(part)).join("|");
}

/** The clock's workspace identity for one observation: project when known. */
export function clockScope(project: string | undefined, session: string): { root: string; client: string; sessionId: string; task: string } {
  return { root: project ?? "", client: project ?? "unallocated", sessionId: session, task: project ?? "unlabeled" };
}

function windowFromRow(row: Record<string, unknown>): ClockWindow {
  return {
    id: String(row.id), root: String(row.root), client: String(row.client), sessionId: String(row.session_id),
    task: String(row.task), start: Number(row.start), end: Number(row.end), kind: String(row.kind) as ClockWindow["kind"],
  };
}

export function newWindowId(): string { return randomUUID(); }
