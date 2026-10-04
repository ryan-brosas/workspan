/** Bounded transport snapshots, separate from report accounting and rendering. */
import { randomUUID } from "node:crypto";
import { ProtocolError, type ReportPage, type ReportQuery } from "../protocol.ts";
import { calendarDate, validateTimezone } from "./calendar.ts";
import { formatReport, type ReportFacts } from "./report.ts";
/** Snapshot lifetime, measured from the last request that used it. */
export const SNAPSHOT_TTL_MS = 300_000;
/** Snapshots retained at once; creating one beyond the cap evicts the oldest. */
export const SNAPSHOT_CAPACITY = 8;
/** Page size and snapshot limit, both in UTF-16 code units (see ReportPage). */
export const PAGE_UNITS = 8_000;
export const MAX_SNAPSHOT_UNITS = 16 * 1024 * 1024;
export function createReportPager(build: (query: ReportQuery) => ReportFacts, now: () => number = Date.now): (params: unknown) => ReportPage {
  const snapshots = new Map<string, { text: string; expires: number }>();
  // Snapshots and every offset here count UTF-16 code units -- the unit `text.length`
  // and `text.slice()` use -- so a CJK-heavy report can exceed this many bytes while
  // staying inside the snapshot limit.

  return params => {
    const value = (params ?? {}) as { period?: unknown; date?: unknown; timezone?: unknown; format?: unknown; token?: unknown; offset?: unknown };
    let token: string, text: string, offset = 0;
    for (const [key, entry] of snapshots) if (entry.expires <= now()) snapshots.delete(key);
    if (value.token !== undefined) {
      if (typeof value.token !== "string" || !Number.isSafeInteger(value.offset) || (value.offset as number) < 0) throw new ProtocolError("bad_request", "invalid report cursor");
      token = value.token; offset = value.offset as number;
      const entry = snapshots.get(token);
      if (!entry) throw new ProtocolError("report_expired", "report snapshot expired; restart the report");
      // Paging a maximum-size snapshot takes thousands of requests, so a client that
      // keeps asking is still using it: resume extends the lifetime while memory stays
      // bounded by the eight-snapshot cap below.
      entry.expires = now() + SNAPSHOT_TTL_MS;
      text = entry.text;
      if (offset > text.length) throw new ProtocolError("bad_request", "invalid report cursor");
    } else {
      if (value.period !== "day" && value.period !== "week") throw new ProtocolError("bad_request", "period must be day or week");
      // The messages below promise a format, so the format is checked here through the
      // same helpers the builder uses, not only by typeof.
      if (value.date !== undefined) { if (typeof value.date !== "string") throw new ProtocolError("bad_request", "date must be YYYY-MM-DD"); calendarDate(value.date); }
      if (value.timezone !== undefined) { if (typeof value.timezone !== "string") throw new ProtocolError("bad_request", "timezone must be an IANA zone"); validateTimezone(value.timezone); }
      const format = value.format ?? "text";
      if (format !== "text" && format !== "json" && format !== "csv" && format !== "md") throw new ProtocolError("bad_request", "format must be text, json, csv or md");
      const facts = build({ period: value.period, date: value.date as string | undefined, timezone: value.timezone as string | undefined, format });
      text = formatReport(facts, format);
      if (text.length > MAX_SNAPSHOT_UNITS) throw new ProtocolError("report_too_large", "report exceeds snapshot limit");
      while (snapshots.size && (snapshots.size >= SNAPSHOT_CAPACITY || [...snapshots.values()].reduce((sum, entry) => sum + entry.text.length, text.length) > MAX_SNAPSHOT_UNITS)) snapshots.delete(snapshots.keys().next().value!);
      token = randomUUID(); snapshots.set(token, { text, expires: now() + SNAPSHOT_TTL_MS });
    }
    let chunk = text.slice(offset, offset + PAGE_UNITS);
    // A page never ends inside a surrogate pair; `next` follows the emitted chunk, so
    // the pairing character always arrives at the start of the next page.
    if (chunk.length > 1 && /[\uD800-\uDBFF]$/.test(chunk)) chunk = chunk.slice(0, -1);
    const end = offset + chunk.length;
    return { token, offset, chunk, next: end < text.length ? end : null };
  };
}
