import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpServer, toolNames } from "../src/mcp.ts";
import type { Method } from "../src/protocol.ts";
import { WorkspanStore } from "../src/daemon/db.ts";
import { startDaemon, type Daemon } from "../src/daemon/server.ts";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

test("the MCP surface lists tools without reading, and only acts when called", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const server = createMcpServer(async (method: Method, params?: unknown) => { calls.push({ method, params }); return { ok: true }; });

  const init = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize" }) as { result: { protocolVersion: string; capabilities: { tools: unknown }; serverInfo: { name: string } } };
  expect(init.result.protocolVersion).toBe("2025-06-18");
  expect(init.result.serverInfo.name).toBe("workspan");
  expect(init.result.capabilities.tools).toBeDefined();

  const list = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }) as { result: { tools: Array<{ name: string; inputSchema: unknown }> } };
  expect(list.result.tools.map(tool => tool.name)).toEqual(toolNames());
  for (const tool of list.result.tools) expect(tool.inputSchema).toBeDefined();
  // Listing and initializing touch nothing: no session can start from a handshake.
  expect(calls).toEqual([]);

  await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "work_status", arguments: {} } });
  expect(calls).toEqual([{ method: "status", params: undefined }]);
  await server.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "work_day", arguments: { date: "2026-10-04" } } });
  expect(calls.at(-1)).toEqual({ method: "day", params: { date: "2026-10-04" } });
  await server.handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "work_note", arguments: { text: "what the person said", idle: true } } });
  expect(calls.at(-1)).toEqual({ method: "session.note", params: { note: "what the person said", idle: true } });
  await server.handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "work_session", arguments: { action: "start", project: "coral" } } });
  expect(calls.at(-1)).toEqual({ method: "session.start", params: { project: "coral" } });

  const emptyNote = await server.handle({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "work_note", arguments: {} } }) as { result: { isError?: boolean } };
  expect(emptyNote.result.isError).toBe(true);
  const badAction = await server.handle({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "work_session", arguments: { action: "delete" } } }) as { result: { isError?: boolean } };
  expect(badAction.result.isError).toBe(true);
  const unknownTool = await server.handle({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "work_total", arguments: {} } }) as { result: { isError?: boolean } };
  expect(unknownTool.result.isError).toBe(true);

  expect(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  const unknown = await server.handle({ jsonrpc: "2.0", id: 10, method: "tools/set" }) as { error: { code: number } };
  expect(unknown.error.code).toBe(-32601);
});

test("the stdio server answers over the real socket through the CLI", async () => {
  const root = mkdtempSync(join(tmpdir(), "workspan-mcp-"));
  roots.push(root);
  const runtimeDir = join(root, "run");
  const store = new WorkspanStore(join(root, "workspan.sqlite"));
  const daemon: Daemon = await startDaemon({ store, runtimeDir, idleGapMs: 900_000 });
  try {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/workspan.ts"), "--socket", join(runtimeDir, "workspan.sock"), "mcp"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n");
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "work_status", arguments: {} } }) + "\n");
    proc.stdin.end();
    const [text, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(await proc.exited).toBe(0);
    expect(stderr).toBe("");
    const lines = text.trim().split("\n").map(line => JSON.parse(line) as { result: { serverInfo?: { name: string }; content?: Array<{ text: string }> } });
    expect(lines[0].result.serverInfo?.name).toBe("workspan");
    expect((JSON.parse(lines[1].result.content![0].text) as { schema: number }).schema).toBe(1);
  } finally { await daemon.close(); store.close(); }
});
