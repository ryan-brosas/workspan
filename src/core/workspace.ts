/**
 * The workspace a path belongs to: walk up to the repository root, or the
 * directory itself when there is no repository. Mechanical, never a client name -
 * attribution is what bindings are for.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function repositoryRoot(cwd: string): string {
  for (let dir = resolve(cwd); ; ) {
    if (existsSync(resolve(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}
