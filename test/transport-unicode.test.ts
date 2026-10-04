import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "../src/client.ts";

test("UTF-8 metadata survives a multibyte character split across socket reads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-unicode-")), socketPath = join(dir, "socket");
  const server = createServer(socket => socket.once("data", chunk => {
    const input = JSON.parse(chunk.toString());
    const bytes = Buffer.from(JSON.stringify({ id: input.id, ok: true, result: { project: "client-猫" } }) + "\n");
    const split = bytes.indexOf(Buffer.from("猫")) + 1;
    socket.write(bytes.subarray(0, split));
    setTimeout(() => socket.end(bytes.subarray(split)), 10);
  }));
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  try { expect(await request("health", undefined, { socketPath })).toEqual({ project: "client-猫" }); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
