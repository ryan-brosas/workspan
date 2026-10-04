import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The package, the plugin manifest and the release tag must not drift apart. */
test("the plugin manifest version matches the package version", () => {
  const root = join(import.meta.dir, "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
  const manifest = JSON.parse(readFileSync(join(root, "plugin", "manifest.json"), "utf8")) as { version?: unknown };
  expect(typeof pkg.version).toBe("string");
  expect(manifest.version).toBe(pkg.version);
});
