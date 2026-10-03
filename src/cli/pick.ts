/**
 * Company selection for work no terminal can see: ChatGPT, the browser, a
 * call, a design review. The workspace-derivation that powers the keybinding has
 * nothing to read there, so the user picks the client from their bindings.
 *
 * The picker uses the shell's own dmenu surface, `omarchy-menu-select`, the same
 * way `omarchy-menu-plugin` builds its dynamic rows - the menu's provider map is
 * closed to third parties (verified installed and upstream), so a static row
 * whose action runs this verb is the supported pattern.
 */
import { spawnSync } from "node:child_process";

export interface Binding { project: string; root: string; explicit: boolean }

export interface PickOptions {
  /** Rows as `label\u0009subtext`: the company, with its bound roots beneath. */
  rows: (bindings: readonly Binding[]) => string[];
  /** Returns the selected project name, or null when the user dismissed. */
  select: (prompt: string, input: string) => string | null;
}

export const defaultRows = (bindings: readonly Binding[]): string[] => {
  // A company can own several roots; one row per company, roots as subtext.
  const byProject = new Map<string, string[]>();
  for (const binding of bindings) {
    const roots = byProject.get(binding.project) ?? [];
    roots.push(binding.root);
    byProject.set(binding.project, roots);
  }
  return [...byProject.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([project, roots]) => `${project}\u0009${roots.join(", ")}`);
};

/** The real surface: the shell's picker, fed the rows on stdin. */
export const menuSelect = (prompt: string, input: string): string | null => {
  const result = spawnSync("omarchy-menu-select", [prompt], { input, encoding: "utf8" });
  if (result.error || result.status !== 0 || !result.stdout.trim()) return null;
  // A row with subtext returns `label<TAB>subtext`; the company is the label.
  return result.stdout.split("\u0009")[0].trim();
};

export function pickProject(bindings: readonly Binding[], options: PickOptions): { project: string } | { dismissed: true } | { none: true } {
  if (!bindings.length) return { none: true };
  const rows = options.rows(bindings);
  if (!rows.length) return { none: true };
  const selected = options.select("Track time for", rows.join("\n"));
  // A label the bindings do not know is never a client: refusing it here keeps
  // the picker from inventing attribution the user never confirmed.
  if (!selected || !bindings.some(binding => binding.project === selected)) return { dismissed: true };
  return { project: selected };
}
