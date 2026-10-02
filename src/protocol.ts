/**
 * The private local wire protocol. One line of JSON per frame, one daemon per
 * user, one socket in the runtime directory. This is a design contract, not a
 * public API: nothing outside this repository should speak it yet.
 */
export const PROTOCOL_VERSION = 1;
/** A single frame is bounded so a malformed or hostile client cannot exhaust the daemon. */
export const MAX_FRAME_BYTES = 64 * 1024;

export const METHODS = ["health", "ingest", "status", "engine", "projects", "session.start", "session.stop"] as const;
export type Method = typeof METHODS[number];

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
