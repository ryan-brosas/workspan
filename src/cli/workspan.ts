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
const FLAGS = new Set(["--socket", "--project", "--session", "--file"]);
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
  if (group === "session" && action === "start") {
    console.log(JSON.stringify(await request("session.start", { project: flag("--project") }), null, 2));
    return 0;
  }
  if (group === "session" && action === "stop") {
    console.log(JSON.stringify(await request("session.stop", { session: flag("--session") }), null, 2));
    return 0;
  }
  if (group === "ingest") {
    const file = flag("--file");
    if (!file) throw new Error("ingest needs --file <jsonl>");
    const events = readFileSync(file, "utf8").split("\n").map(line => line.trim()).filter(Boolean).map(line => JSON.parse(line) as unknown);
    console.log(JSON.stringify(await request("ingest", { events }), null, 2));
    return 0;
  }
  throw new Error("usage: workspan status|health|ingest --file f.jsonl|session start --project P|session stop --session S");
}

main().then(code => process.exit(code)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
