/** Bounded transport snapshots, separate from report accounting and rendering. */
import { randomUUID } from "node:crypto";
import { ProtocolError, type ReportPage, type ReportQuery } from "../protocol.ts";
import { formatReport, type ReportFacts } from "./report.ts";
export function createReportPager(build: (query: ReportQuery) => ReportFacts, now: () => number = Date.now): (params: unknown) => ReportPage {
  const snapshots = new Map<string, { text: string; expires: number }>();
  const limit = 16 * 1024 * 1024;
  return params => {
    const value = (params ?? {}) as { period?: unknown; date?: unknown; timezone?: unknown; format?: unknown; token?: unknown; offset?: unknown };
    let token: string, text: string, offset = 0;
    for (const [key, entry] of snapshots) if (entry.expires <= now()) snapshots.delete(key);
    if (value.token !== undefined) {
      if (typeof value.token !== "string" || !Number.isSafeInteger(value.offset) || (value.offset as number) < 0) throw new ProtocolError("bad_request", "invalid report cursor");
      token = value.token; offset = value.offset as number;
      const entry = snapshots.get(token);
      if (!entry) throw new ProtocolError("report_expired", "report snapshot expired; restart the report");
      text = entry.text;
      if (offset > text.length) throw new ProtocolError("bad_request", "invalid report cursor");
    } else {
      if (value.period !== "day" && value.period !== "week") throw new ProtocolError("bad_request", "period must be day or week");
      if (value.date !== undefined && typeof value.date !== "string") throw new ProtocolError("bad_request", "date must be YYYY-MM-DD");
      if (value.timezone !== undefined && typeof value.timezone !== "string") throw new ProtocolError("bad_request", "timezone must be an IANA zone");
      const format = value.format ?? "text";
      if (format !== "text" && format !== "json" && format !== "csv" && format !== "md") throw new ProtocolError("bad_request", "format must be text, json, csv or md");
      const facts = build({ period: value.period, date: value.date as string | undefined, timezone: value.timezone as string | undefined, format });
      text = formatReport(facts, format);
      if (text.length > limit) throw new ProtocolError("report_too_large", "report exceeds snapshot limit");
      while (snapshots.size && (snapshots.size >= 8 || [...snapshots.values()].reduce((sum, entry) => sum + entry.text.length, text.length) > limit)) snapshots.delete(snapshots.keys().next().value!);
      token = randomUUID(); snapshots.set(token, { text, expires: now() + 300_000 });
    }
    const chunk = text.slice(offset, offset + 8_000), end = offset + chunk.length;
    return { token, offset, chunk, next: end < text.length ? end : null };
  };
}
