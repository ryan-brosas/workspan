import { expect, test } from "bun:test";
import { encodeFrame, fail, ok, parseRequest, parseResponse, ProtocolError, MAX_FRAME_BYTES } from "../src/protocol.ts";

test("a request round-trips through one frame", () => {
  const line = encodeFrame({ v: 1, id: "r1", method: "status" });
  expect(line.endsWith("\n")).toBe(true);
  expect(parseRequest(line.trim())).toMatchObject({ v: 1, id: "r1", method: "status" });
});

test("an unsupported protocol version is rejected instead of guessed", () => {
  expect(() => parseRequest(JSON.stringify({ v: 2, id: "r1", method: "status" }))).toThrow(ProtocolError);
  expect(() => parseRequest(JSON.stringify({ id: "r1", method: "status" }))).toThrow("unsupported protocol version");
});

test("the engine method is part of the contract", () => {
  expect(parseRequest(JSON.stringify({ v: 1, id: "r1", method: "engine" })).method).toBe("engine");
});

test("an unknown method is rejected rather than silently ignored", () => {
  expect(() => parseRequest(JSON.stringify({ v: 1, id: "r1", method: "shutdown" }))).toThrow("unknown method");
});

test("an oversized frame is refused before parsing", () => {
  const huge = JSON.stringify({ v: 1, id: "r1", method: "status", params: { pad: "x".repeat(MAX_FRAME_BYTES) } });
  expect(() => parseRequest(huge)).toThrow("frame exceeds");
});

test("responses keep success and failure distinguishable", () => {
  expect(parseResponse(encodeFrame(ok("r1", { a: 1 })).trim())).toEqual({ id: "r1", ok: true, result: { a: 1 } });
  const failure = parseResponse(encodeFrame(fail("r2", "bad_request", "nope")).trim());
  expect(failure).toEqual({ id: "r2", ok: false, error: { code: "bad_request", message: "nope" } });
});
