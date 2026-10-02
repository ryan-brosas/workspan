#!/usr/bin/env bun
/**
 * The only client. It speaks the local protocol and never opens the database.
 * Usage: workspan status --json | health | ingest --file f.jsonl |
 *        session start --project P | session stop --session S
 */
import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { socketPath as defaultSocket } from "../daemon/paths.ts";
import { encodeFrame, parseResponse, PROTOCOL_VERSION, type Method } from "../protocol.ts";

const args = process.argv.slice(2);
const FLAGS = new Set(["--socket", "--project", "--session", "--file", "--db", "--since-days", "--since-hours", "--limit", "--instance", "--turns", "--chunks", "--target", "--map", "--tracker-db"]);
const flags = (name: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === name && args[i + 1] !== undefined) out.push(args[i + 1]);
  return out;
};
const flag = (name: string): string | undefined => { const at = args.indexOf(name); return at === -1 ? undefined : args[at + 1]; };
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (FLAGS.has(args[i])) { i++; continue; }
  if (args[i].startsWith("--")) continue;
  positional.push(args[i]);
}
const socketFile = flag("--socket") ?? defaultSocket();

function request(method: Method, params?: unknown, id = `cli-${Date.now()}`): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = connect(socketFile);
    let buffer = "";
    const fail = (message: string) => { client.destroy(); reject(new Error(message)); };
    client.setTimeout(5000);
    client.on("connect", () => client.write(encodeFrame({ v: PROTOCOL_VERSION, id, method, params })));
    client.on("data", chunk => {
      buffer += chunk.toString("utf8");
      const index = buffer.indexOf("\n");
      if (index === -1) return;
      try {
        const response = parseResponse(buffer.slice(0, index));
        client.destroy();
        if (response.ok) resolve(response.result);
        else reject(new Error(`${response.error.code}: ${response.error.message}`));
      } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    });
    client.on("timeout", () => fail(`daemon not responding at ${socketFile}`));
    client.on("error", error => fail(`cannot reach the Workspan daemon at ${socketFile} (${(error as NodeJS.ErrnoException).code ?? "error"}); start it with: workspan daemon`));
  });
}

async function main(): Promise<number> {
  const [group, action] = positional;
  if (group === "health") { console.log(JSON.stringify(await request("health"), null, 2)); return 0; }
  if (group === "status") { console.log(JSON.stringify(await request("status"), null, 2)); return 0; }
  if (group === "projects") {
    const { bindings } = await request("projects") as { bindings: Array<{ root: string; project: string; explicit: boolean; source: string }> };
    for (const binding of bindings) console.log(`${binding.explicit ? "explicit " : "provisional"}  ${binding.project.padEnd(28)} ${binding.root}  (${binding.source})`);
    if (bindings.length === 0) console.log("no project bindings yet");
    return 0;
  }
  if (group === "engine") {
    const report = await request("engine") as { engine: Record<string, unknown>; check: { ok: boolean; expected: number; reported: number } };
    console.log(JSON.stringify(report, null, 2));
    if (args.includes("--check") && !report.check.ok) return 1;
    return 0;
  }
  if (group === "session" && action === "start") {
    console.log(JSON.stringify(await request("session.start", { project: flag("--project") }), null, 2));
    return 0;
  }
  if (group === "session" && action === "stop") {
    console.log(JSON.stringify(await request("session.stop", { session: flag("--session") }), null, 2));
    return 0;
  }
  if (group === "audit") {
    // Read-only and local: it reads receipt files, classifies them with the Bend
    // audit lane and reports. Nothing is ingested, so it is safe to run against
    // real history before any migration is approved.
    const turns = flag("--turns");
    const chunks = flag("--chunks");
    if (!turns || !chunks) throw new Error("audit needs --turns <file.jsonl> and --chunks <file.jsonl>");
    const { auditReceipts } = await import("../adapters/receipt-audit.ts");
    const report = auditReceipts({ turnsLog: turns, chunksLog: chunks, ...(flag("--instance") ? { label: flag("--instance")! } : {}) });
    console.log(JSON.stringify(report, null, 2));
    // The gate: a scope with unresolved rows is not fit to migrate yet.
    if (args.includes("--require-clean") && report.review.length > 0) {
      console.error(`audit is not clean: ${report.review.length} receipt(s) need review`);
      return 1;
    }
    return 0;
  }
  if (group === "migrate") {
    const chunks = flag("--chunks");
    const target = flag("--target");
    if (!chunks || !target) throw new Error("migrate needs --chunks <file.jsonl> and --target <database>");
    const scopeMap: Record<string, string> = {};
    for (const pair of flags("--map")) {
      const at = pair.indexOf("=");
      if (at <= 0) throw new Error("--map needs scope=project");
      scopeMap[pair.slice(0, at)] = pair.slice(at + 1);
    }
    const { migratePiHistory } = await import("../adapters/migrate.ts");
    const report = migratePiHistory({
      chunksLog: chunks,
      targetDatabase: target,
      scopeMap,
      ...(flag("--tracker-db") ? { trackerDatabase: flag("--tracker-db")! } : {}),
      apply: args.includes("--apply"),
      allowLiveDatabase: args.includes("--allow-live-database"),
      ...(flag("--instance") ? { instance: flag("--instance")! } : {}),
    });
    if (report.reconciliation && !(report.reconciliation.agent.equal && report.reconciliation.inferred.equal)) {
      console.error(JSON.stringify(report, null, 2));
      console.error("migration reconciliation failed: imported evidence does not match the source");
      return 1;
    }
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }
  if (group === "ingest-codex") {
    // Reading another application's history is the adapter's job, and it is
    // read-only: no prompts, no item bodies, no error payloads are selected.
    const { collectCodexEvents } = await import("../adapters/codex.ts");
    const days = Number(flag("--since-days") ?? NaN);
    const hours = Number(flag("--since-hours") ?? NaN);
    const windowMs = Number.isFinite(days) ? days * 86_400_000 : (Number.isFinite(hours) ? hours * 3_600_000 : 86_400_000);
    const collected = collectCodexEvents({
      sinceMs: Date.now() - windowMs,
      limit: Number.isFinite(Number(flag("--limit"))) ? Number(flag("--limit")) : 5000,
      ...(flag("--db") ? { dbPath: flag("--db")! } : {}),
      ...(flag("--instance") ? { instance: flag("--instance")! } : {}),
    });
    if (args.includes("--dry-run")) {
      console.log(JSON.stringify({ ...collected.summary, dry_run: true, ingested: 0 }, null, 2));
      return 0;
    }
    const result = await request("ingest", { events: collected.events });
    console.log(JSON.stringify({ read: collected.summary, ingest: result }, null, 2));
    return 0;
  }
  if (group === "ingest") {
    const file = flag("--file");
    if (!file) throw new Error("ingest needs --file <jsonl>");
    const events = readFileSync(file, "utf8").split("\n").map(line => line.trim()).filter(Boolean).map(line => JSON.parse(line) as unknown);
    console.log(JSON.stringify(await request("ingest", { events }), null, 2));
    return 0;
  }
  throw new Error("usage: workspan status|engine [--check]|health|ingest --file f.jsonl|ingest-codex [--since-days N] [--dry-run]|audit --turns f.jsonl --chunks f.jsonl [--require-clean]|projects|migrate --chunks f.jsonl --target db [--tracker-db pi.sqlite] [--map scope=project] [--apply]|session start --project P|session stop --session S");
}

main().then(code => process.exit(code)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
