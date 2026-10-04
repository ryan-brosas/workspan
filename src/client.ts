/** Client-facing request builders over the shared transport: paged report reads and the CLI/MCP convenience surface. */
import { request, defaultSocketPath, type RequestOptions } from "./spool.ts";
import type { Method, ReportQuery, ReportPage } from "./protocol.ts";

/**
 * Fetch chunks of one immutable snapshot; a changing ledger cannot mix pages.
 * Offsets and the size cap count UTF-16 code units, matching the daemon slicing in
 * report-pages.ts, so a page boundary may split a surrogate pair: concatenate every
 * page in order and never treat one page as standalone text.
 */
export async function readReport(query: ReportQuery, send: (method: Method, params?: unknown) => Promise<unknown>): Promise<string> {
  let params: unknown = query, token: string | null = null, offset = 0, text = "";
  for (;;) {
    const page = await send("report", params) as ReportPage;
    if (typeof page !== "object" || page === null || typeof page.chunk !== "string" || typeof page.token !== "string" || page.offset !== offset || (token !== null && page.token !== token)) throw new Error("bad_response: invalid report page");
    token = page.token;
    text += page.chunk;
    if (text.length > 16 * 1024 * 1024) throw new Error("report_too_large: report exceeds the snapshot limit");
    if (page.next === null) return text;
    if (!Number.isSafeInteger(page.next) || page.next !== offset + page.chunk.length || page.next <= offset) throw new Error("bad_response: invalid report cursor");
    offset = page.next;
    params = { token, offset };
  }
}

export class WorkspanClient {
  readonly socketPath: string;
  constructor(options: RequestOptions = {}) { this.socketPath = options.socketPath ?? defaultSocketPath(); }
  request(method: Method, params?: unknown): Promise<unknown> { return request(method, params, { socketPath: this.socketPath }); }
  health(): Promise<unknown> { return this.request("health"); }
  status(): Promise<unknown> { return this.request("status"); }
  day(options: { date?: string; timezone?: string } = {}): Promise<unknown> { return this.request("day", options); }
  report(query: ReportQuery): Promise<string> { return readReport(query, (method, params) => this.request(method, params)); }
  sessions(): Promise<unknown> { return this.request("session.list"); }
  projects(): Promise<unknown> { return this.request("projects"); }
  ingest(events: readonly unknown[]): Promise<unknown> { return this.request("ingest", { events }); }
  session(action: "start" | "stop" | "pause" | "resume" | "toggle" | "switch", params: Record<string, unknown> = {}): Promise<unknown> { return this.request(`session.${action}` as Method, params); }
  note(params: { note: string; session?: string; idle?: boolean }): Promise<unknown> { return this.request("session.note", params); }
  bind(root: string, project: string, explicit = true): Promise<unknown> { return this.request("projects.bind", { root, project, explicit }); }
}
