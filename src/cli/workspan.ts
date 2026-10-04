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
import type { Binding } from "./pick.ts";
import { parseMoment } from "./moment.ts";

const args = process.argv.slice(2);
const FLAGS = new Set(["--socket", "--project", "--root", "--explicit", "--session", "--file", "--db", "--since-days", "--since-hours", "--limit", "--instance", "--turns", "--chunks", "--target", "--map", "--tracker-db", "--at"]);
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

/** A stated correction moment. The daemon speaks epoch milliseconds; the person does not. */
const moment = (): { at?: number } => {
  const raw = flag("--at");
  return raw === undefined ? {} : { at: parseMoment(raw, Date.now()) };
};

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
/** The socket frame is capped at 64 KiB; a big import goes in batches that fit. */
function batchEvents(events: readonly unknown[], maxBytes = 48_000): unknown[][] {
  const batches: unknown[][] = [];
  let current: unknown[] = [];
  let size = 0;
  for (const event of events) {
    const bytes = JSON.stringify(event).length + 2;
    if (current.length > 0 && size + bytes > maxBytes) { batches.push(current); current = []; size = 0; }
    current.push(event);
    size += bytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Import in frame-sized batches; numeric counters merge, so the caller sees one result. */
async function ingestBatched(events: readonly unknown[]): Promise<Record<string, number>> {
  const totals: Record<string, number> = {};
  const batches = batchEvents(events);
  for (const batch of batches) {
    const result = await request("ingest", { events: batch });
    if (result && typeof result === "object") {
      for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
        if (typeof value === "number") totals[key] = (totals[key] ?? 0) + value;
      }
    }
  }
  totals.batches = batches.length;
  return totals;
}

async function main(): Promise<number> {
  const [group, action] = positional;
  if (group === "health") { console.log(JSON.stringify(await request("health"), null, 2)); return 0; }
  if (group === "daemon") {
    // The foreground daemon, as the packaged unit starts it. The daemon owns this
    // process from here until it is signalled, so no exit path is taken.
    await import("../daemon/main.ts");
    return new Promise<number>(() => undefined);
  }
  if (group === "status") { console.log(JSON.stringify(await request("status"), null, 2)); return 0; }
  if (group === "projects" && action === "bind") {
    const root = positional[2];
    const project = positional[3];
    if (!root || !project) throw new Error("usage: workspan projects bind <root> <project> [--explicit]");
    const { bindings } = await request("projects.bind", { root, project, explicit: args.includes("--explicit") }) as { bindings: Array<{ root: string; project: string; explicit: boolean; source: string }> };
    for (const binding of bindings) console.log(`${binding.explicit ? "explicit " : "provisional"}  ${binding.project.padEnd(28)} ${binding.root}  (${binding.source})`);
    return 0;
  }
  if (group === "projects" && args.includes("--json")) {
    const { bindings } = await request("projects") as { bindings: Array<{ root: string; project: string; explicit: boolean; source: string }> };
    console.log(JSON.stringify(bindings));
    return 0;
  }
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
  // An explicit project wins; an explicit root is second best; otherwise the hit
  // derives the workspace the user is actually in - Herdr's focused pane, then the
  // focused window's process tree - and the daemon resolves the client from the
  // binding. Nothing here names a client on its own.
  type SessionOrigin = "project" | "root" | "herdr" | "window" | "none";
  type SessionResult = { action?: string; project?: string | null; root?: string | null; session?: string };
  const sessionParams = async (): Promise<{ params: Record<string, string>; origin: SessionOrigin }> => {
    const project = flag("--project");
    const root = flag("--root");
    if (project) return { params: { project }, origin: "project" };
    if (root) return { params: { root }, origin: "root" };
    const { focusedRoot } = await import("./focused-root.ts");
    const derived = await focusedRoot();
    if (derived) return { params: { root: derived.root }, origin: derived.source };
    return { params: {}, origin: "none" };
  };

  // JSON stays on stdout for machines; this one line goes to stderr so a wrong
  // attribution is visible the moment it happens instead of in a report later.
  const announce = (result: SessionResult | undefined, origin: SessionOrigin, params: Record<string, string>): void => {
    if (result?.action === "stopped") {
      console.error(`tracking stopped · ${result.session ?? "session"}`);
      return;
    }
    const project = result?.project ?? null;
    const root = result?.root ?? params.root ?? null;
    if (!project) {
      console.error(root ? `tracking (unallocated) · no binding for ${root}` : "tracking (unallocated) · no focused workspace");
      return;
    }
    const where =
      origin === "herdr" ? `from Herdr pane ${root}` :
      origin === "window" ? `from focused window ${root}` :
      origin === "root" ? `explicit root ${root}` :
      origin === "project" ? "explicit project" :
      "";
    console.error(where ? `tracking ${project} · ${where}` : `tracking ${project}`);
  };

  if (group === "session" && action === "start") {
    const { params, origin } = await sessionParams();
    const result = (await request("session.start", { ...params, ...moment() })) as SessionResult;
    announce(result, origin, params);
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (group === "session" && action === "toggle") {
    const { params, origin } = await sessionParams();
    const result = (await request("session.toggle", params)) as SessionResult;
    announce(result, origin, params);
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (group === "session" && action === "pause") { console.log(JSON.stringify(await request("session.pause", moment()), null, 2)); return 0; }
  if (group === "session" && action === "resume") { console.log(JSON.stringify(await request("session.resume", moment()), null, 2)); return 0; }
  if (group === "session" && action === "switch") {
    const { params, origin } = await sessionParams();
    const result = (await request("session.switch", params)) as SessionResult;
    announce(result, origin, params);
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (group === "session" && action === "pick") {
    // Outside-harness work: no terminal is focused, so the workspace cannot be
    // derived. The user picks a company from their bindings on the shell's picker.
    const { defaultRows, menuSelect, pickProject } = await import("./pick.ts");
    const { bindings } = await request("projects") as { bindings: Binding[] };
    const picked = pickProject(bindings, { rows: defaultRows, select: menuSelect });
    if ("none" in picked) throw new Error("no project bindings yet; add one with: workspan projects bind <root> <project>");
    if ("dismissed" in picked) return 0;
    console.log(JSON.stringify(await request("session.switch", { project: picked.project }), null, 2));
    return 0;
  }
  if (group === "session" && action === "stop") {
    const note = flag("--note");
    console.log(JSON.stringify(await request("session.stop", { session: flag("--session"), ...(note !== undefined ? { note } : {}), ...moment() }), null, 2));
    return 0;
  }
  if (group === "note") {
    // One command while the session is open; --note on stop covers the common case.
    // --session attaches to a past session, and --idle attaches to the session the
    // last finished seat-idle stretch happened in - what the popup nudge asks for.
    const text = positional.slice(1).join(" ");
    if (!text) throw new Error("usage: workspan note <what you did> [--session S | --idle]");
    const target = flag("--session");
    console.log(JSON.stringify(await request("session.note", {
      note: text,
      ...(target !== undefined ? { session: target } : {}),
      ...(args.includes("--idle") ? { idle: true } : {}),
    }), null, 2));
    return 0;
  }
  if (group === "session" && action === "remove") {
    const session = flag("--session");
    const reason = flag("--reason");
    if (!session || !reason) throw new Error("usage: workspan session remove --session <id> --reason <why>");
    console.log(JSON.stringify(await request("session.remove", { session, reason }), null, 2));
    return 0;
  }
  if (group === "session" && action === "list") {
    const result = await request("session.list") as { sessions: Array<{ session: string; project: string | null; state: string; removedAt: number | null; removedReason: string | null }> };
    for (const row of result.sessions) {
      const flag = row.removedAt !== null ? `  removed: ${row.removedReason}` : "";
      console.log(`${row.session}  ${String(row.project ?? "unallocated").padEnd(24)} ${row.state.padEnd(8)}${flag}`);
    }
    if (!result.sessions.length) console.log("no sessions yet");
    return 0;
  }
  if (group === "day") {
    const report = await request("day", { ...(flag("--date") ? { date: flag("--date") } : {}), ...(flag("--tz") ? { timezone: flag("--tz") } : {}) }) as { text: string };
    console.log(report.text);
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
  if (group === "signals") {
    // Presence is not attendance: this says the app was used, never that anyone
    // worked. Computed on demand, stored nowhere, and no measure ever sees it.
    const { readDotPresence } = await import("./signals.ts");
    console.log(JSON.stringify({ dot: readDotPresence() }, null, 2));
    return 0;
  }
  if (group === "harness") {
    // Which local agent histories exist and how fresh they are - availability
    // first, evidence later. Probing reads a store's metadata, never its records.
    const { harnessReaders } = await import("../adapters/registry.ts");
    const now = Date.now();
    const readers = harnessReaders().map(reader => ({ id: reader.id, source: reader.source, ...reader.probe({ now }) }));
    console.log(JSON.stringify({ readers }, null, 2));
    return 0;
  }
  if (group === "ingest-harness") {
    // One verb for every harness: each reader reports its own store and freshness,
    // and a missing store is unavailable, never zero.
    const { collectHarness } = await import("../adapters/registry.ts");
    const days = Number(flag("--since-days") ?? NaN);
    const hours = Number(flag("--since-hours") ?? NaN);
    const windowMs = Number.isFinite(days) ? days * 86_400_000 : (Number.isFinite(hours) ? hours * 3_600_000 : 86_400_000);
    const collected = collectHarness({
      sinceMs: Date.now() - windowMs,
      ...(Number.isFinite(Number(flag("--limit"))) ? { limit: Number(flag("--limit")) } : {}),
      ...(flag("--id") ? { id: flag("--id")! } : {}),
    });
    const events = collected.flatMap(entry => entry.events);
    const readers = collected.map(entry => ({ id: entry.id, source: entry.source, ...entry.summary }));
    if (args.includes("--dry-run")) {
      console.log(JSON.stringify({ readers, events: events.length, dry_run: true, ingested: 0 }, null, 2));
      return 0;
    }
    const result = events.length ? await ingestBatched(events) : null;
    console.log(JSON.stringify({ readers, events: events.length, ingest: result }, null, 2));
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
    if (collected.summary.store === null) {
      console.error("codex: no local thread history store found - local Codex usage is unavailable, not zero");
    }
    if (args.includes("--dry-run")) {
      console.log(JSON.stringify({ ...collected.summary, dry_run: true, ingested: 0 }, null, 2));
      return 0;
    }
    const result = await ingestBatched(collected.events);
    console.log(JSON.stringify({ read: collected.summary, ingest: result }, null, 2));
    return 0;
  }
  if (group === "ingest") {
    const file = flag("--file");
    // `--stdin` is how the collector ingest loop feeds evidence in: a pipe keeps the
    // collector free of any transport of its own.
    const piped = args.includes("--stdin");
    if (!file && !piped) throw new Error("ingest needs --file <jsonl> or --stdin");
    const text = file ? readFileSync(file, "utf8") : readFileSync(0, "utf8");
    const events = text.split("\n").map(line => line.trim()).filter(Boolean).map(line => JSON.parse(line) as unknown);
    console.log(JSON.stringify(await request("ingest", { events }), null, 2));
    return 0;
  }
  throw new Error("usage: workspan daemon|status|engine [--check]|health|ingest --file f.jsonl|ingest-codex [--since-days N] [--dry-run]|harness|ingest-harness [--id X] [--since-days N] [--dry-run]|audit --turns f.jsonl --chunks f.jsonl [--require-clean]|projects|signals|migrate --chunks f.jsonl --target db [--tracker-db pi.sqlite] [--map scope=project] [--apply]|session start|pause|resume|stop|switch|toggle --project P [--at HH:MM|ISO|ms]|note <text> [--session S | --idle]|day");
}

main().then(code => process.exit(code)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
