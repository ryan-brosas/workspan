import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "../src/spool.ts";

test("UTF-8 metadata survives a multibyte character split across socket reads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-unicode-")), socketPath = join(dir, "socket");
  const server = createServer(socket => {
    let buffer = "";
    // The client may hang up mid-answer; that is not a server failure here.
    socket.on("error", () => socket.destroy());
    socket.on("data", chunk => {
      buffer += chunk.toString();
      const index = buffer.indexOf("\n");
      if (index === -1) return;
      const input = JSON.parse(buffer.slice(0, index));
      const bytes = Buffer.from(JSON.stringify({ id: input.id, ok: true, result: { project: "client-猫" } }) + "\n");
      const split = bytes.indexOf(Buffer.from("猫")) + 1;
      socket.write(bytes.subarray(0, split));
      // The delayed tail is cleared when the socket closes, so it can never write to a
      // connection the client already tore down.
      const timer = setTimeout(() => { if (!socket.destroyed) socket.end(bytes.subarray(split)); }, 10);
      socket.once("close", () => clearTimeout(timer));
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  try { expect(await request("health", undefined, { socketPath })).toEqual({ project: "client-猫" }); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
