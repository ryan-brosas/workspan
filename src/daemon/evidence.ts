/**
 * The evidence envelope. Adapters normalize their own records into this shape;
 * the daemon never accepts vendor JSON directly. Fields are allowlisted and
 * bounded, and nothing here can carry a prompt, a title, a URL or a credential.
 */
import { createHash } from "node:crypto";

export const EVIDENCE_VERSION = 1;
export const KINDS = ["interaction", "agent-start", "agent-end", "session-start", "session-stop", "session-pause", "session-resume"] as const;
export const ORIGINS = ["human", "automated", "attested", "unknown"] as const;

/** Sources are namespaces, not vendor payloads: a value here names a `source_namespace`. */
export const SOURCES = ["pi", "codex", "opencode", "claude", "desktop", "manual"] as const;

export type Kind = typeof KINDS[number];
export type Origin = typeof ORIGINS[number];
export type Source = typeof SOURCES[number];

export interface EvidenceEvent {
  /** Source namespace, e.g. "pi". */
  source: Source;
  /** Adapter/account/device identity. Never a credential. */
  instance: string;
  /** Source session identity, stable across replays. */
  session: string;
  /** Source event identity, stable across replays — not a received-at timestamp. */
  event: string;
  kind: Kind;
  /** UTC event time in integer milliseconds. */
  at: number;
  origin: Origin;
  /** Explicit attribution. Absent means unallocated, never a guessed client. */
  project?: string;
  /**
   * The workspace the evidence happened in: the repository root, derived mechanically
   * from the working directory. It is not a client name - a binding resolves it, and
   * recording it lets a confirmed binding re-attribute later without re-importing.
   */
  root?: string;
}

/**
 * Stable identity: source + instance + session + event. `received_at` and retry
 * counters are deliberately excluded, so a retried delivery is the same event.
 */
export function eventId(event: Pick<EvidenceEvent, "source" | "instance" | "session" | "event">): string {
  return [event.source, event.instance, event.session, event.event].join("\u0000");
}

/**
 * Canonical metadata fingerprint. Two deliveries of one identity with different
 * this value are a conflict, not a silent overwrite; the same value is a duplicate.
 */
export function fingerprint(event: EvidenceEvent): string {
  const canonical = JSON.stringify([event.source, event.instance, event.session, event.event, event.kind, event.at, event.origin, event.project ?? null, event.root ?? null]);
  return createHash("sha256").update(canonical).digest("hex");
}

const MAX_FIELD = 128;
const MAX_EPOCH_MS = 8.64e15;

function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_FIELD) throw new Error(`${field} must be 1-${MAX_FIELD} characters`);
  if (/[\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(trimmed)) throw new Error(`${field} must be a single line`);
  return trimmed;
}

/** Validate and normalize an inbound record. Anything unrecognized is rejected. */
export function validateEvent(raw: unknown): EvidenceEvent {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("event must be an object");
  const value = raw as Record<string, unknown>;
  const allowed = new Set(["v", "source", "instance", "session", "event", "kind", "at", "origin", "project", "root"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unexpected field ${JSON.stringify(key)}`);
  if (value.v !== undefined && value.v !== EVIDENCE_VERSION) throw new Error(`unsupported evidence version ${JSON.stringify(value.v)}`);
  const source = text(value.source, "source");
  if (!(SOURCES as readonly string[]).includes(source)) throw new Error(`unknown source ${JSON.stringify(source)}`);
  const kind = text(value.kind, "kind");
  if (!(KINDS as readonly string[]).includes(kind)) throw new Error(`unknown kind ${JSON.stringify(kind)}`);
  const origin = text(value.origin, "origin");
  if (!(ORIGINS as readonly string[]).includes(origin)) throw new Error(`unknown origin ${JSON.stringify(origin)}`);
  const at = value.at;
  if (!Number.isSafeInteger(at) || (at as number) < 0 || (at as number) > MAX_EPOCH_MS) throw new Error("at must be integer epoch milliseconds");
  return {
    source: source as Source,
    instance: text(value.instance, "instance"),
    session: text(value.session, "session"),
    event: text(value.event, "event"),
    kind: kind as Kind,
    at: at as number,
    origin: origin as Origin,
    project: value.project === undefined ? undefined : text(value.project, "project"),
    root: value.root === undefined ? undefined : text(value.root, "root"),
  };
}
