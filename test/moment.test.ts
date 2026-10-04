import { expect, test } from "bun:test";
import { parseMoment } from "../src/cli/moment.ts";

// A local 15:30, built from local parts so the expectations hold in any zone.
const now = new Date(2026, 9, 4, 15, 30, 0, 0).getTime();
const at = (hours: number, minutes: number): number => new Date(2026, 9, 4, hours, minutes, 0, 0).getTime();

test("a correction moment is a clock time today, an ISO timestamp, or epoch milliseconds", () => {
  expect(parseMoment("14:05", now)).toBe(at(14, 5));
  expect(parseMoment("09:00", now)).toBe(at(9, 0));
  expect(parseMoment(String(now - 3_600_000), now)).toBe(now - 3_600_000);
  expect(parseMoment(new Date(now - 7_200_000).toISOString(), now)).toBe(now - 7_200_000);
  expect(parseMoment(" 13:15 ", now)).toBe(at(13, 15));
});

test("a moment that has not happened, an impossible clock time and nonsense are refused", () => {
  expect(() => parseMoment("16:00", now)).toThrow(/future/);
  expect(() => parseMoment(String(now + 60_000), now)).toThrow(/future/);
  expect(() => parseMoment(new Date(now + 60_000).toISOString(), now)).toThrow(/future/);
  expect(() => parseMoment("25:00", now)).toThrow(/clock time/);
  expect(() => parseMoment("", now)).toThrow(/needs a moment/);
  expect(() => parseMoment("yesterday-ish", now)).toThrow(/cannot read/);
});

test("epoch seconds are not milliseconds and are refused rather than guessed", () => {
  expect(() => parseMoment("1791114896", now)).toThrow();
});
