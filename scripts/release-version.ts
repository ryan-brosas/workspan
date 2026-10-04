#!/usr/bin/env bun
/**
 * The next release version, derived from the commit history since the last tag.
 *
 * One authority: the version comes from what actually landed, so a merge to main
 * releases without anyone deciding a number. Conventional Commits decide the level
 * (a breaking change is major, otherwise feat is minor and anything else that changed
 * the tree is patch), and every version file is stamped from one list here so they
 * cannot drift.
 *
 * Usage:
 *   bun scripts/release-version.ts [--bump auto|patch|minor|major|prerelease]
 *                                  [--version x.y.z] [--write] [--json] [--last-tag vX]
 *
 * With --write the stamped paths go to stderr and stdout carries exactly the version,
 * so a workflow can capture it with $(...) without filtering anything.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

export type Level = "none" | "patch" | "minor" | "major" | "prerelease";
export interface VersionFile { path: string; stamp: (text: string, version: string) => string }
export interface ReleaseState {
  lastTag: string;
  current: string;
  subjects: number;
  level: Level;
  version: string | null;
  base: string;
}

/** Every file that states the released version; the list is the source of truth. */
export const VERSION_FILES: VersionFile[] = [
  { path: "package.json", stamp: (text, version) => text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`) },
  { path: "plugin/manifest.json", stamp: (text, version) => text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`) },
  { path: "src/mcp.ts", stamp: (text, version) => text.replace(/(name: "workspan", version: ")[^"]+(")/, `$1${version}$2`) },
];

/** Semver ordering that understands prerelease tags, e.g. v0.1.0-rc.1 before v0.1.0. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(value.replace(/^v/, ""));
    if (!match) throw new Error(`not a version: ${value}`);
    return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] ?? null };
  };
  const left = parse(a), right = parse(b);
  for (let i = 0; i < 3; i++) if (left.numbers[i] !== right.numbers[i]) return left.numbers[i] - right.numbers[i];
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease.localeCompare(right.prerelease);
}

/** The highest version among tags, ignoring anything that is not a vX.Y.Z tag. */
export function latestVersion(tags: readonly string[]): string | null {
  const versions = tags.map(tag => tag.trim()).filter(tag => /^v?\d+\.\d+\.\d+(-.+)?$/.test(tag));
  if (!versions.length) return null;
  return versions.sort(compareVersions).at(-1)!.replace(/^v/, "");
}

/** The release level a set of commit subjects asks for. */
export function classify(subjects: readonly string[]): Level {
  let level: Level = "none";
  for (const subject of subjects) {
    const text = subject.trim();
    if (!text || /^chore\(release\):/.test(text)) continue;
    if (/^[a-z]+(\([^)]*\))?!:/.test(text) || /BREAKING CHANGE:/.test(text)) return "major";
    if (/^feat(\([^)]*\))?:/.test(text)) level = "minor";
    else if (level === "none") level = "patch";
  }
  return level;
}

/** The version after `current`, for one level; `prerelease` counts rc.N up. */
export function nextVersion(current: string, level: Level, explicit?: string): string | null {
  if (explicit) return explicit.replace(/^v/, "");
  if (level === "none") return null;
  const base = current.replace(/^v/, "");
  const prerelease = /-(.+)$/.exec(base)?.[1] ?? null;
  const [major, minor, patch] = base.split("-")[0].split(".").map(Number);
  if (level === "prerelease") return prerelease ? `${major}.${minor}.${patch}-${bumpPrerelease(prerelease)}` : `${major}.${minor}.${patch + 1}-rc.1`;
  // A prerelease that gains real changes is finalized before anything else moves on.
  if (prerelease) return `${major}.${minor}.${patch}`;
  if (level === "major") return `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function bumpPrerelease(value: string): string {
  const match = /^(.*?)(\d+)$/.exec(value);
  return match ? `${match[1]}${Number(match[2]) + 1}` : `${value}.1`;
}

/** The highest vX.Y.Z tag anywhere, for a repository whose HEAD has none reachable. */
function latestTaggedVersion(): string {
  return latestVersion(tryGit("tag", "--sort=-v:refname").split("\n").filter(Boolean)) ?? "";
}

function git(...args: string[]): string {
  return String(execFileSync("git", args, { encoding: "utf8" })).trim();
}

/**
 * A git query whose absence is a state, not a failure: a repository with no tag yet.
 * Its stderr is dropped too, because "No names found" is the expected answer there.
 */
function tryGit(...args: string[]): string {
  try {
    return String(execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] as ("ignore" | "pipe")[] })).trim();
  } catch { return ""; }
}

/** Stamp one version into every version file, returning the paths written. */
export function stampVersion(version: string, files: readonly VersionFile[] = VERSION_FILES): string[] {
  const stamped: string[] = [];
  for (const file of files) {
    const text = readFileSync(file.path, "utf8");
    const next = file.stamp(text, version);
    if (next === text) {
      // Already at this version: a retry after a partial failure, not an error. The
      // file must still carry a version, otherwise the pattern has drifted.
      if (!text.includes(version)) throw new Error(`${file.path} does not carry a version to stamp`);
      continue;
    }
    writeFileSync(file.path, next);
    stamped.push(file.path);
  }
  return stamped;
}

/** The version state of the working tree: the last tag, the commits after it, the level. */
export function releaseState(options: { lastTag?: string; explicit?: string; bump?: string } = {}): ReleaseState {
  const lastTag = options.lastTag ?? tryGit("describe", "--tags", "--abbrev=0", "HEAD", "--match", "v*");
  const currentTag = lastTag || latestTaggedVersion();
  const current = currentTag ? currentTag.replace(/^v/, "") : "0.0.0";
  const subjects = lastTag ? git("log", "--format=%s", `${lastTag}..HEAD`).split("\n").filter(Boolean) : [];
  const level = classify(subjects);
  const base = options.bump ?? level;
  const requested = (base === "auto" || base === "none" ? level : base) as Level;
  return { lastTag, current, subjects: subjects.length, level, version: nextVersion(current, requested, options.explicit), base };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const read = (name: string): string | undefined => { const at = args.indexOf(name); return at === -1 ? undefined : args[at + 1]; };
  const state = releaseState({ explicit: read("--version"), lastTag: read("--last-tag"), bump: read("--bump") });
  if (args.includes("--write")) {
    if (!state.version) throw new Error("nothing to release: no releasable commit since the last tag");
    // The stamped paths are diagnostics; stdout stays exactly the version.
    for (const path of stampVersion(state.version)) console.error(`stamped ${path}`);
  }
  if (args.includes("--json")) console.log(JSON.stringify(state, null, 2));
  else if (state.version) console.log(state.version);
  else console.error("nothing releasable since the last tag");
}
