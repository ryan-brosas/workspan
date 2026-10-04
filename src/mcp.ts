/**
 * `workspan mcp`: the agent-facing tool surface, spoken over stdio.
 *
 * It is a thin proxy: each tool call becomes one or more daemon requests (a paged
 * `work_report` follows the snapshot page by page), so the daemon stays the only
 * writer and Bend stays the only accounting authority. The read tools are side-effect
 * free; the mutating tools exist for the case where a person asked for them in the
 * conversation - nothing here starts a session because an agent happened to run, and
 * no tool writes a note that the person did not ask for.
 */
import type { Method } from "./protocol.ts";
import { WorkspanClient, readReport } from "./client.ts";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const SERVER_INFO = { name: "workspan", version: "0.3.0" } as const;

interface Tool { name: string; description: string; inputSchema: Record<string, unknown> }

const object = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> =>
  ({ type: "object", properties, required, additionalProperties: false });

const TOOLS: Tool[] = [
  {
    name: "work_status",
    description: "The local work-time status: the current session, the three separate measures (attested, inferred attended, agent runtime), coverage, the last seat-idle annotation and the stretches of today no measure covers.",
    inputSchema: object({}),
  },
  {
    name: "work_day",
    description: "The day report as text: attested sessions with notes and pauses, the measures separately, seat-idle annotations, and the stretches no measure covers.",
    inputSchema: object({ date: { type: "string", description: "Local day as YYYY-MM-DD; omit for today" }, timezone: { type: "string", description: "IANA zone; omit for the daemon host's zone" } }),
  },
  {
    name: "work_report",
    description: "Read one immutable day or Monday-Sunday week report. Exact separate measures, provenance, provisional sessions and coverage; never a billing total.",
    inputSchema: object({
      period: { type: "string", enum: ["day", "week"] },
      date: { type: "string", description: "Local day as YYYY-MM-DD; omit for today. For a week, any day inside that Monday-Sunday week" },
      timezone: { type: "string", description: "IANA zone; omit for the daemon host's zone" },
      format: { type: "string", enum: ["text", "json", "csv", "md"], description: "Report output format; defaults to json" },
    }, ["period"]),
  },
  {
    name: "work_sessions",
    description: "Every attested session with its state, project and removal reason, oldest first. Use the `session` value with the other session tools.",
    inputSchema: object({}),
  },
  {
    name: "work_projects",
    description: "The confirmed project bindings: which workspace root resolves to which project. A directory name is never a client on its own.",
    inputSchema: object({}),
  },
  {
    name: "work_note",
    description: "Record one short note the person dictated, attached to a session. Pass idle: true to attach it to the session the last finished seat-idle stretch happened in. Never invent a note; only the person's own words.",
    inputSchema: object({
      text: { type: "string", description: "One line, at most 200 characters, the person's own words" },
      session: { type: "string", description: "A session value from work_sessions; omit to use the open session" },
      idle: { type: "boolean", description: "Attach to the session of the last finished seat-idle stretch" },
    }, ["text"]),
  },
  {
    name: "work_session",
    description: "Start, stop, pause, resume or toggle a work session. Use only when the person explicitly asked; agent activity alone never starts a session.",
    inputSchema: object({
      action: { type: "string", enum: ["start", "stop", "pause", "resume", "toggle"] },
      project: { type: "string", description: "Explicit project name" },
      root: { type: "string", description: "Workspace root; the daemon resolves the project from a binding" },
      session: { type: "string", description: "For stop/pause/resume: a session value from work_sessions" },
      at: { type: "integer", description: "Epoch milliseconds to correct the moment; must not be in the future" },
    }, ["action"]),
  },
];

export function toolNames(): string[] { return TOOLS.map(tool => tool.name); }

export type Requester = (method: Method, params?: unknown) => Promise<unknown>;

interface RpcRequest { jsonrpc?: string; id?: unknown; method?: string; params?: unknown }

const text = (value: unknown): { content: Array<{ type: "text"; text: string }> } => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});
const toolError = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

/**
 * One MCP server over an injected requester, so the tool wiring is testable without a
 * socket and the transport is testable without a model.
 */
export function createMcpServer(request: Requester): { handle(message: unknown): Promise<unknown | null>; tools: readonly Tool[] } {
  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (name) {
      case "work_status": return text(await request("status"));
      case "work_day": {
        const params: Record<string, unknown> = {};
        if (typeof args.date === "string") params.date = args.date;
        if (typeof args.timezone === "string") params.timezone = args.timezone;
        const report = (await request("day", params)) as { text?: string };
        return text(report.text ?? report);
      }
      case "work_report": {
        if (args.period !== "day" && args.period !== "week") return toolError(`work_report needs day or week; got ${JSON.stringify(args.period)}`);
        const format = args.format ?? "json";
        if (format !== "text" && format !== "json" && format !== "csv" && format !== "md") return toolError(`invalid report format ${JSON.stringify(args.format)}; expected text, json, csv, or md`);
        // A present-but-wrong value is an error the caller can fix, never silently
        // dropped: a discarded argument would report the default period as success.
        if (args.date !== undefined && typeof args.date !== "string") return toolError(`work_report date must be a string; got ${JSON.stringify(args.date)}`);
        if (args.timezone !== undefined && typeof args.timezone !== "string") return toolError(`work_report timezone must be a string; got ${JSON.stringify(args.timezone)}`);
        return text(await readReport({ period: args.period, format, ...(typeof args.date === "string" ? { date: args.date } : {}), ...(typeof args.timezone === "string" ? { timezone: args.timezone } : {}) }, request));
      }
      case "work_sessions": return text(await request("session.list"));
      case "work_projects": return text(await request("projects"));
      case "work_note": {
        if (typeof args.text !== "string" || !args.text.trim()) return toolError("work_note needs the person's text");
        const params: Record<string, unknown> = { note: args.text };
        if (typeof args.session === "string") params.session = args.session;
        if (args.idle === true) params.idle = true;
        return text(await request("session.note", params));
      }
      case "work_session": {
        const action = String(args.action ?? "");
        if (!["start", "stop", "pause", "resume", "toggle"].includes(action)) return toolError(`work_session needs one of start, stop, pause, resume, toggle; got ${JSON.stringify(args.action)}`);
        const params: Record<string, unknown> = {};
        for (const key of ["project", "root", "session", "at"] as const) if (args[key] !== undefined) params[key] = args[key];
        return text(await request(`session.${action}` as Method, params));
      }
      default: return toolError(`unknown tool ${name}`);
    }
  };

  const handle = async (message: unknown): Promise<unknown | null> => {
    const rpc = (message ?? {}) as RpcRequest;
    const id = rpc.id ?? null;
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const error = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
    if (typeof rpc.method !== "string") return error(-32600, "a request needs a method");
    switch (rpc.method) {
      case "initialize":
        return reply({ protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS });
      case "tools/call": {
        const params = (rpc.params ?? {}) as { name?: unknown; arguments?: unknown };
        if (typeof params.name !== "string") return error(-32602, "tools/call needs a tool name");
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        if (!Array.isArray(args) && typeof args === "object" && args !== null) {
          try { return reply(await call(params.name, args)); }
          catch (failure) { return reply(toolError(failure instanceof Error ? failure.message : String(failure))); }
        }
        return error(-32602, "tools/call arguments must be an object");
      }
      default:
        return error(-32601, `unknown method ${JSON.stringify(rpc.method)}`);
    }
  };

  return { handle, tools: TOOLS };
}

/** Serve the tools on stdio, one JSON-RPC message per line, until the input closes. */
export async function serveMcpStdio(options: { socketPath?: string; input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {}): Promise<void> {
  const client = new WorkspanClient({ socketPath: options.socketPath });
  const server = createMcpServer((method, params) => client.request(method, params));
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  let buffer = "";
  for await (const chunk of input) {
    buffer += chunk.toString();
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (!line) continue;
      let response: unknown = null;
      try { response = await server.handle(JSON.parse(line)); }
      catch (failure) { response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: failure instanceof Error ? failure.message : "parse error" } }; }
      if (response) output.write(JSON.stringify(response) + "\n");
    }
  }
}
