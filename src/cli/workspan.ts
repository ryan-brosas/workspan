#!/usr/bin/env bun
/**
 * The only client. It speaks the local protocol and never opens the database.
 * Usage: workspan status --json | health | ingest --file f.jsonl |
 *        session start --project P | session stop --session S |
 *        day|week [--date YYYY-MM-DD] [--tz ZONE] [--json | --export csv|md]
 */
import { readFileSync } from "node:fs";
import { socketPath as defaultSocket } from "../daemon/paths.ts";
import { request as daemonRequest, batchEvidence, eventFitsBatch } from "../spool.ts";
import { readReport } from "../client.ts";
import type { Method } from "../protocol.ts";
import type { Status } from "../daemon/measures.ts";
import type { Binding } from "./pick.ts";
import { parseMoment } from "./moment.ts";

const args = process.argv.slice(2);
const FLAGS = new Set(["--socket", "--project", "--root", "--explicit", "--session", "--file", "--db", "--since-days", "--since-hours", "--limit", "--instance", "--turns", "--chunks", "--target", "--map", "--tracker-db", "--at", "--date", "--tz", "--export", "--keep"]);
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

/** One request through the shared client library, bound to this CLI's socket. */
const request = (method: Method, params?: unknown): Promise<unknown> =>
  daemonRequest(method, params, { socketPath: socketFile });

/**
 * The roots that carry time and no client: the offer the desktop surface needs
 * ("name this directory") instead of only a total. Every row names its measure,
 * because the measures are never added together.
 */
async function printUnallocatedRoots(): Promise<void> {
  const status = await request("status") as { measures: Record<string, { unallocated_roots?: Array<{ root: string; ms: number }> }> };
  const rows = Object.entries(status.measures ?? {}).flatMap(([measure, value]) => (value.unallocated_roots ?? []).map(row => ({ measure, ...row })));
  if (!rows.length) return;
  console.log("unallocated, per measure (never added together):");
  for (const row of rows.slice(0, 5)) {
    console.log(`  ${row.measure.padEnd(8)} ${Math.round(row.ms / 60_000)}m  ${row.root}  -> workspan projects confirm ${row.root} <client>`);
  }
}

/** Import in frame-sized batches; numeric counters merge, so the caller sees one result. */
async function ingestBatched(events: readonly unknown[]): Promise<Record<string, number>> {
  const totals: Record<string, number> = {};
  // One record too large for any frame must not abort the whole import: refuse it
  // individually, deliver everything else, and report the count to the caller.
  const deliverable = events.filter(eventFitsBatch);
  const refused = events.length - deliverable.length;
  // batchEvidence keeps each frame far below the protocol's 64 KiB limit, envelope
  // included, so an ingest batch built here cannot be refused as frame_too_large.
  const batches = batchEvidence(deliverable);
  for (const batch of batches) {
    const result = await request("ingest", { events: batch }) as Record<string, unknown> | null;
    // Fail closed: a daemon answer without numeric counters must not read as "no
    // conflicts" and exit 0 over evidence that was never accounted for.
    const counters = ["accepted", "duplicates", "conflicts"] as const;
    if (!result || counters.some(name => typeof result[name] !== "number")) throw new Error(`daemon answered without ingest counters: ${JSON.stringify(result)}`);
    for (const name of counters) totals[name] = (totals[name] ?? 0) + (result[name] as number);
  }
  totals.batches = batches.length;
  if (refused > 0) totals.refused_too_large = refused;
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
  // Confirming a derived label is a correction, not a new claim: the project name is
  // carried over and only the explicit flag changes, so a guessed client becomes a
  // named one without retyping it.
  if (group === "projects" && action === "confirm") {
    const root = positional[2];
    if (!root) throw new Error("usage: workspan projects confirm <root> [project]");
    let project = positional[3];
    if (!project) {
      const { bindings } = await request("projects") as { bindings: Array<{ root: string; project: string; explicit: boolean }> };
      const existing = bindings.find(binding => binding.root === root);
      if (!existing) throw new Error(`no binding for ${root}; name it: workspan projects confirm ${root} <project>`);
      project = existing.project;
    }
    const { bindings } = await request("projects.bind", { root, project, explicit: true }) as { bindings: Array<{ root: string; project: string; explicit: boolean }> };
    for (const binding of bindings.filter(row => row.root === root)) {
      console.log(`explicit     ${binding.project.padEnd(28)} ${binding.root}`);
    }
    return 0;
  }
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
    await printUnallocatedRoots();
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
    // The words are scanned from the tokens after the group: a note is not a flag,
    // so "--debugged the parser" stays the person's words instead of vanishing.
    const start = args.indexOf("note") + 1;
    const words: string[] = [];
    for (let i = start; i < args.length; i++) {
      if (args[i] === "--idle") continue;
      if (args[i] === "--session" || args[i] === "--socket") { i++; continue; }
      words.push(args[i]);
    }
    const text = words.join(" ");
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
  if (group === "day" || group === "week") {
    const exported = flag("--export");
    if (args.includes("--export") && exported !== "csv" && exported !== "md") throw new Error("--export must be csv or md");
    if (exported && args.includes("--json")) throw new Error("choose --json or --export, not both");
    const format = args.includes("--json") ? "json" : exported ?? "text";
    const text = await readReport({ period: group, format: format as "text" | "json" | "csv" | "md", ...(flag("--date") ? { date: flag("--date") } : {}), ...(flag("--tz") ? { timezone: flag("--tz") } : {}) }, request);
    // A pipe write is asynchronous: exiting before the callback would truncate a
    // week of CSV or a JSON snapshot for whatever is reading it.
    await new Promise<void>(resolve => { process.stdout.write(text.endsWith("\n") ? text : text + "\n", () => resolve()); });
    return 0;
  }
  if (group === "backup") {
    const raw = flag("--keep");
    if (args.includes("--keep") && (raw === undefined || !/^[1-9]\d*$/.test(raw))) throw new Error("--keep must be a positive integer");
    console.log(JSON.stringify(await request("backup", { ...(raw === undefined ? {} : { keep: Number(raw) }) }), null, 2));
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
    const { probeHarness } = await import("../adapters/registry.ts");
    const readers = probeHarness({ now: Date.now() });
    // What the daemon's own periodic pass last did, when it is running: detection
    // is automatic, and "never scanned" must not look like "nothing found".
    let automatic: Status["harness"] | null = null;
    try { automatic = ((await request("status", {})) as Status).harness ?? null; }
    // A diagnostic must not present an unreachable daemon as "no automatic pass":
    // the failure is named on stderr, and the field stays null.
    catch (error) { automatic = null; console.error(`workspan harness: cannot read the daemon status: ${error instanceof Error ? error.message : String(error)}`); }
    console.log(JSON.stringify({ readers, automatic }, null, 2));
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
    // Line by line, so a malformed record is named by position and the cause survives;
    // `--file` is left exactly as it was, and `--stdin` was consumed by the reader.
    const lines = text.split("\n");
    const events: unknown[] = [];
    for (const [index, line] of lines.entries()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { events.push(JSON.parse(trimmed) as unknown); }
      catch (error) { throw new Error(`invalid_jsonl at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    const result = await ingestBatched(events);
    console.log(JSON.stringify(result, null, 2));
    if (result.refused_too_large > 0) { console.error(`event_too_large: ${result.refused_too_large} record(s) exceed the frame limit and were not sent; the file is unchanged`); return 1; }
    // A conflict is recorded for review, never a delivery failure: the daemon already
    // holds that identity, so a resend could not change the outcome. Exiting non-zero
    // would make the collector retry the same spool forever - the stuck lane this
    // whole delivery path exists to avoid.
    if (result.conflicts > 0) console.error(`evidence_conflict: ${result.conflicts} record(s) retained for review; the batch is delivered`);
    return 0;
  }
  if (group === "doctor") {
    // One read-only verdict over the daemon, the status file, the collector unit and
    // its spool, the database file and every evidence source.
    const { runDoctor } = await import("./doctor.ts");
    const report = await runDoctor({ socketPath: socketFile });
    if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else {
      for (const check of report.checks) console.log(`${check.state === "ok" ? "ok  " : check.state === "attention" ? "warn" : "?   "} ${check.name}: ${check.detail}`);
      console.log(`verdict: ${report.verdict}`);
    }
    // A warning is information; a daemon that cannot answer is a failure.
    return report.checks.some(check => check.name === "daemon" && check.state === "ok") ? 0 : 1;
  }
  if (group === "mcp") {
    // The agent-facing tools speak the same protocol through the same client library.
    const { serveMcpStdio } = await import("../mcp.ts");
    await serveMcpStdio({ socketPath: socketFile });
    // The last response has to reach the client before this process exits.
    await new Promise<void>(resolve => { process.stdout.write("", () => resolve()); });
    return 0;
  }
  throw new Error("usage: workspan daemon|status|engine [--check]|health|doctor [--json]|mcp|ingest --file f.jsonl|ingest --stdin|ingest-codex [--since-days N] [--dry-run]|harness|ingest-harness [--id X] [--since-days N] [--dry-run]|audit --turns f.jsonl --chunks f.jsonl [--require-clean]|projects|signals|migrate --chunks f.jsonl --target db [--tracker-db pi.sqlite] [--map scope=project] [--apply]|session start|pause|resume|stop|switch|toggle --project P [--at HH:MM|ISO|ms]|note <text> [--session S | --idle]|day|week [--date YYYY-MM-DD] [--tz ZONE] [--json|--export csv|md]|backup [--keep N]");
}

main().then(code => process.exit(code)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
