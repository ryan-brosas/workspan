/**
 * Where is the user working right now?
 *
 * A manual hit should attribute to the workspace in front of them, not to a
 * client baked into a keybinding. Two signals, in order of trust:
 *   1. Herdr's foreground pane - when the user works through Herdr, it already
 *      knows which pane is focused and that pane's working directory.
 *   2. The focused window's process tree - a terminal's shell and the tools it
 *      runs carry the session's directory in /proc/<pid>/cwd.
 * Both yield a workspace root. Neither yields a client: the daemon resolves the
 * project from bindings, and an unbound root stays unallocated.
 */
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { repositoryRoot } from "../core/workspace.ts";

/** A process tree this size is a runaway, not a terminal. */
const MAX_PROCESSES = 200;

/**
 * /proc, /sys, /dev and /run are process plumbing, not workspaces: a transient
 * child can briefly report such a path as its cwd, and it must never become the
 * root a session attributes to. "/" is the same noise.
 */
export function plausibleCwd(cwd: string): boolean {
  return cwd !== "/" && !/^(\/proc|\/sys|\/dev|\/run)(\/|$)/.test(cwd);
}

export function childrenOf(pid: number): number[] {
  try {
    const out: number[] = [];
    for (const tid of readdirSync(join("/proc", String(pid), "task"))) {
      const text = readFileSync(join("/proc", String(pid), "task", tid, "children"), "utf8");
      for (const token of text.split(/\s+/)) if (token) out.push(Number(token));
    }
    return out.filter(candidate => Number.isSafeInteger(candidate) && candidate > 0);
  } catch { return []; }
}

export function cwdOf(pid: number): string | null {
  try { return readlinkSync(join("/proc", String(pid), "cwd")); }
  catch { return null; }
}

/** The repository roots of a process tree, breadth first. "/" is noise, not work. */
export function descendantRoots(pid: number): string[] {
  const seen = new Set<number>([pid]);
  const queue = [pid];
  const roots: string[] = [];
  while (queue.length && seen.size < MAX_PROCESSES) {
    const current = queue.shift()!;
    const cwd = cwdOf(current);
    if (cwd && plausibleCwd(cwd)) roots.push(repositoryRoot(cwd));
    for (const child of childrenOf(current)) {
      if (!seen.has(child)) { seen.add(child); queue.push(child); }
    }
  }
  return roots;
}

/** Most of the tree usually shares one directory; on a tie the first seen wins. */
export function majorityRoot(roots: readonly string[]): string | null {
  if (!roots.length) return null;
  const counts = new Map<string, number>();
  for (const root of roots) counts.set(root, (counts.get(root) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const [root, count] of counts) {
    if (count > bestCount) { best = root; bestCount = count; }
  }
  return best;
}

export function pickForegroundCwd(agents: unknown): string | null {
  if (!Array.isArray(agents)) return null;
  for (const agent of agents) {
    if (agent && typeof agent === "object") {
      const value = (agent as { foreground_cwd?: unknown }).foreground_cwd;
      if (typeof value === "string" && value.trim() !== "") return value;
    }
  }
  return null;
}

async function request(socketPath: string, method: string, params: unknown): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const client = connect(socketPath);
    let buffer = "";
    client.setTimeout(500);
    client.on("connect", () => client.write(JSON.stringify({ id: randomUUID(), method, params }) + "\n"));
    client.on("data", chunk => {
      buffer += chunk.toString("utf8");
      const at = buffer.indexOf("\n");
      if (at === -1) return;
      try {
        const response = JSON.parse(buffer.slice(0, at)) as { result?: { agents?: unknown } };
        client.destroy();
        resolvePromise(response.result);
      } catch (error) { client.destroy(); reject(error); }
    });
    client.on("timeout", () => { client.destroy(); reject(new Error("herdr not responding")); });
    client.on("error", error => { client.destroy(); reject(error); });
  });
}

export function defaultHerdrSocketPath(): string {
  return process.env.HERDR_SOCKET ?? join(homedir(), ".config", "herdr", "herdr.sock");
}

/** Herdr's focused pane, when Herdr is running and one of its panes is focused. */
export async function herdrForegroundCwd(socketPath: string = defaultHerdrSocketPath()): Promise<string | null> {
  try {
    const result = await request(socketPath, "agent.list", {}) as { agents?: unknown } | undefined;
    return pickForegroundCwd(result?.agents);
  } catch { return null; }
}

/** The focused window's process tree, when Hyprland answers. */
export function focusedWindowRoot(): string | null {
  const output = spawnSync("hyprctl", ["-j", "activewindow"], { encoding: "utf8", timeout: 2_000 });
  if (output.error || output.status !== 0 || !output.stdout.trim()) return null;
  try {
    const pid = (JSON.parse(output.stdout) as { pid?: unknown }).pid;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid)) return null;
    return majorityRoot(descendantRoots(pid));
  } catch { return null; }
}

export async function focusedRoot(): Promise<string | null> {
  const viaHerdr = await herdrForegroundCwd();
  if (viaHerdr) return repositoryRoot(viaHerdr);
  return focusedWindowRoot();
}
