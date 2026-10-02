# Bend in Workspan

Bend owns the arithmetic. This file is the operational record: what runs, how it is
pinned, how to prove it, and what is still open.

## What Bend owns

| Policy | Source | Where it runs |
| --- | --- | --- |
| Interval union (deduplicate, sort, merge, epoch-precision totals) | `src/core/engine.bend` → `src/core/batch.bend` | every measure total in `status.json` |
| Receipt classification (consistent, legacy, missing, checkpoint-only, mismatch, conflict) | `src/core/audit.bend` | the audit lane, `auditTurnReceipts` |

No JavaScript in this repository computes a measure total. `src/daemon/measures.ts`
calls `reconcileIntervals`, and the allocation partition it does own is a derived
view of those totals that a test cross-checks against the policy.

## Two lanes, one policy

| Lane | Selected by | Needs a compiler |
| --- | --- | --- |
| **Generated** (default) | nothing | no — `src/core/generated/policy.mjs` is committed |
| **Native** | `BEND_EXECUTABLE`, `WORKTIME_BEND_BINARY`, or an explicit `NativeOptions` | at build time; the artifact is a compiled binary |

The generated lane is the product path: a clean checkout runs, reports and tests
with no compiler present. The native lane exists for parity and for hosts that
would rather ship a binary than a JS runtime. Selection is explicit, and a failure
is never hidden by falling back to the other lane:

```sh
bun src/cli/workspan.ts engine --check   # label, artifact digest, live probe
```

## The pin

`scripts/bend-toolchain.json` is the single owner of the toolchain:

| Field | Value |
| --- | --- |
| Compiler | Bend `2.0.31` (`sha256 f7dbecc8…`) |
| Build source revision | `1e80ddce5940c9db8fe914f4b13a1f85a0e45b2b` (`sha256 989ba778…`) |

The build-time `bend2` source is required only to regenerate the artifact or to
build a native binary; the compiler on `PATH` alone is not enough. Fetch both into
an isolated directory (never over an existing Bend installation):

```sh
bash scripts/install-bend-ci.sh /tmp/bend-ci
export PATH=/tmp/bend-ci/bin:$PATH BEND_SOURCE_DIR=/tmp/bend-ci/source
```

## Checks

```sh
bun run build:check    # artifact matches its sources (drift fails the gate)
bun run proof:check    # every stated audit law is proven, on the pinned compiler
bun test               # policy tests, lane parity, daemon, adapters, widget helpers
bun run check          # types
```

Set the compiler on `PATH` — **not** `BEND_EXECUTABLE` — when running the suite:
that variable deliberately *selects* the native lane, and the tests that assert the
default lane will fail if it is set.

## What is proven, and what is not

`src/core/LAWS.bend` states its own limits, and they are worth repeating here: the
proofs cover receipt classification — conflict precedence, absent-summary
checkpoint, zero-interval legacy/missing and equal-total coverage. They are **not**
a proof of host IO, of interval-union correctness, or of anything about storage,
sockets or human provenance. `status(row, False{})`, present-summary routing and
unequal-total mismatch are covered by tests rather than by laws.

The proof gate is mutation-checked: a deliberately broken `audit.bend` fails its
law (not the syntax), and deleting a proof turns the law into an open claim
(`TODO found`) rather than passing quietly.

## Verified on this host

| Claim | Evidence |
| --- | --- |
| The committed artifact is what the committed sources produce | `build:check` regenerates it byte-identically with the pinned compiler |
| The laws hold | `proof:check` — 3/3, including both mutation cases |
| Both lanes agree | `test/native.test.ts` runs the generated and native lanes against the same corpus and a seeded coverage oracle, including 1,200 overlapping receipts and 12,000 groups |
| The engine is identifiable at runtime | `status.json.engine` reports label, `sha256` of the artifact, compiler version read from the artifact header, and the source file names |

## Open items

- **The audit lane is not wired to adapters yet.** `auditTurnReceipts` is exercised
  by tests but nothing calls it in production; receipt reconciliation for imported
  history is M5 work.
- **The native build cache is named `pi-worktime-native`** in `$XDG_CACHE_HOME`,
  carried over with the inherited `native.ts`. The key is content-addressed, so
  sharing the directory is harmless, but the name is a tracker artefact.
- **Allocation policy is JavaScript.** `partitionByProject` decides which project a
  union segment belongs to. It is a derived view that a test pins to the Bend total;
  moving it into the policy would be new policy, and would need its own laws.
