# Releases

A merge to `main` releases itself. Nobody chooses a number, and nobody tags by hand:

1. `.github/workflows/release.yml` runs the same gates CI runs (`verify.yml`) on the
   revision that landed.
2. `scripts/release-version.ts` derives the next version from the commits since the
   last tag (Conventional Commits: a breaking change is major, otherwise `feat` is
   minor and anything else that changed the tree is patch), then stamps it into every
   version file: `package.json`, `plugin/manifest.json` and `SERVER_INFO` in
   `src/mcp.ts`. The list of stamped files is the single source of truth.
3. That stamping lands as `chore(release): vX.Y.Z [skip ci]`, with an annotated tag
   `vX.Y.Z` on the same commit. The `[skip ci]` marker (and a guard on the commit
   subject) is what stops a release from triggering a release.
4. The release is published with generated notes and the Omarchy plugin package
   `workspan.tracker-<version>.zip`. A tag containing a hyphen (`v0.2.0-rc.1`) is
   published as a pre-release.

## When it does not run

- **Nothing releasable since the last tag.** The version job reports
  `released=false` and stops; no empty release appears.
- **The head is already a release commit.** The same guard stops a second pass.
- **An existing release.** `publish` leaves an existing `vX.Y.Z` release untouched
  (and the version job refuses to tag an existing tag), so a re-run is safe.

## Deliberate exceptions

- **A human-pushed `vX.Y.Z` tag** still publishes exactly that revision, without
  deriving a version. The package check requires `plugin/manifest.json` to already
  state that version.
- **`workflow_dispatch`** runs the same automatic path with an explicit level
  (`patch`/`minor`/`major`/`prerelease`) or an exact `version`, which is how a
  pre-release is cut (`version: 0.2.0-rc.1`).

## Verifying locally

```sh
bun test test/release-version.test.ts      # level and version arithmetic
bun scripts/release-version.ts            # what the next merge would release
bun scripts/release-version.ts --bump minor --write   # stamp, then git diff to review
```

The version job stamps only version literals and then proves the three files parse and
agree before committing them; the publish job proves the packaged manifest states the
version it is published under. A release that fails can be re-run from the Actions tab
(`Re-run failed jobs`) or dispatched again.
