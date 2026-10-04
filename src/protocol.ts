/**
 * The local wire protocol: one line of JSON per frame, one daemon per user, one
 * socket in the runtime directory. This is the public integration contract for local
 * harness adapters and tools (docs/protocol.md): within a version the surface only
 * grows, and every frame states the version it speaks.
 */
export const PROTOCOL_VERSION = 1;
/** A single frame is bounded so a malformed or hostile client cannot exhaust the daemon. */
export const MAX_FRAME_BYTES = 64 * 1024;

export const METHODS = ["health", "ingest", "status", "engine", "projects", "projects.bind", "session.start", "session.pause", "session.resume", "session.stop", "session.note", "session.switch", "session.toggle", "session.remove", "session.list", "day", "report", "backup"] as const;
export type Method = typeof METHODS[number];

/** A day or Monday-Sunday week report; the numbers in it are always the stored measures. */
export interface ReportQuery {
  period: "day" | "week";
  /**
   * Local calendar date, `YYYY-MM-DD`, read in `timezone`. Defaults to the daemon's
   * local today. For a week, any day inside the target week: the plan covers that
   * week's Monday through Sunday.
   */
  date?: string;
  /** IANA zone identifier, e.g. `Europe/Lisbon`; defaults to the daemon host's zone. */
  timezone?: string;
  /** Output format; `text` when omitted, except the MCP `work_report` tool, which defaults to `json`. */
  format?: "text" | "json" | "csv" | "md";
}
/** One immutable snapshot is fetched in pages: send the last page's `token` and `next` back. */
export interface ReportContinuation { token: string; offset: number }
/**
 * One page of a report snapshot. `offset`, `next` and the snapshot size limit are all
 * measured in UTF-16 code units -- the unit of `chunk` and of every `String` offset; a
 * non-ASCII report is therefore larger in bytes than its offset suggests. `chunk` never
 * ends inside a surrogate pair, `next` is `offset + chunk.length` or null on the last
 * page, and the snapshot (and its token) expires five minutes after the last request
 * that used it, after which the client restarts the query as `report_expired`.
 */
export interface ReportPage { token: string; offset: number; next: number | null; chunk: string }
/** A consistent snapshot of the ledger; `keep` is how many snapshots to retain. */
export interface BackupQuery { keep?: number }
export type { BackupResult } from "./daemon/backup.ts";

export interface Request { v: number; id: string; method: Method; params?: unknown }
export interface ErrorBody { code: string; message: string }
export type Response =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: ErrorBody };

/** A protocol violation. Codes are stable; messages stay bounded and content-free. */
export class ProtocolError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function encodeFrame(value: unknown): string { return JSON.stringify(value) + "\n"; }

function parseLine(line: string): Record<string, unknown> {
  if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new ProtocolError("frame_too_large", `frame exceeds ${MAX_FRAME_BYTES} bytes`);
  let value: unknown;
  try { value = JSON.parse(line); }
  catch { throw new ProtocolError("bad_json", "frame is not JSON"); }
  if (!isObject(value)) throw new ProtocolError("bad_request", "frame must be an object");
  return value;
}

export function parseRequest(line: string): Request {
  const value = parseLine(line);
  if (value.v !== PROTOCOL_VERSION) throw new ProtocolError("bad_version", `unsupported protocol version ${JSON.stringify(value.v)}`);
  if (typeof value.id !== "string" || value.id === "") throw new ProtocolError("bad_request", "request needs a non-empty string id");
  if (typeof value.method !== "string" || !(METHODS as readonly string[]).includes(value.method))
    throw new ProtocolError("unknown_method", `unknown method ${JSON.stringify(value.method)}`);
  return { v: value.v, id: value.id, method: value.method as Method, params: value.params };
}

export function parseResponse(line: string): Response {
  const value = parseLine(line);
  if (typeof value.id !== "string") throw new ProtocolError("bad_response", "response needs a string id");
  if (value.ok === true) return { id: value.id, ok: true, result: value.result };
  const error = isObject(value.error) ? value.error : {};
  return {
    id: value.id,
    ok: false,
    error: {
      code: typeof error.code === "string" ? error.code : "unknown",
      message: typeof error.message === "string" ? error.message : "request failed",
    },
  };
}

export const ok = (id: string, result: unknown): Response => ({ id, ok: true, result });
export const fail = (id: string, code: string, message: string): Response => ({ id, ok: false, error: { code, message } });
