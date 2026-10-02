# Inherited accounting core

Workspan's accounting is not a rewrite. The interval policy, storage vocabulary
and Bend sources are inherited from the existing tracker so there is one
implementation of the arithmetic, not two that drift.

## Source

| | |
| --- | --- |
| Repository | `ryan-brosas/pi-time-tracker` |
| Revision | `931c74c024a24ae7800a66fe21bccecbf19a945b` (clean tree) |
| License | MIT |

## Inherited files

`sha256` is of the upstream file at that revision, so drift is detectable.

| Workspan | Upstream | sha256 |
| --- | --- | --- |
| `src/core/ledger.ts` | `ledger.ts` | `1b8377654c7093e6da3c77eabd03994866c2b85bead72f29e32169c25e331ac6` |
| `src/core/native.ts` | `native.ts` | `80d82538177efef80f0172321e5c66f759e09a5d057ca3b72463e8f37a38f186` |
| `src/core/engine.bend` | `engine.bend` | `c860f41d9200696911b7b74bce42abc5d61af69d9b2ecef4c7cb5dbb07d4172c` |
| `src/core/batch.bend` | `batch.bend` | `c26fd720d06a45ce387b9b49cdb6bfc6b690412442927f6d53651b7018a2bcca` |
| `src/core/audit.bend` | `audit.bend` | `73394644f09700d9e6a5fb4984d81315481ad242182db8224608326dcae0bffa` |
| `src/core/generated/policy.mjs` | `generated/policy.mjs` | `144316b726023c9e320fce225345680441fb2dbc0ea1cc623c111b129ca524a9` |
| `src/core/generated/policy.d.mts` | `generated/policy.d.mts` | `0acb9a5c81fff18dc43747763dfe5948a238ff9690fc49b92bbcf1d629e8587d` |
| `src/core/LAWS.bend` | `LAWS.bend` | `9ecf1df257c0092467ddd760dff6d4fadcdb09c1dc8be9fbea4869e802c2b493` |
| `src/core/PROOF.bend` | `PROOF.bend` | `63da53e0e146f74da7b961c20fecc05087b9dd206a88246f05211ff7b8b48289` |
| `THIRD_PARTY_NOTICES.md` | `THIRD_PARTY_NOTICES.md` | `e043982002cb41779cb7782f09a6db754679a4a447e7663109fb0bc97edeb786` |

The copied `.ts` files carry a one-line provenance header; the `.bend` sources,
the generated artifact and the notices are byte-identical to upstream. The
`.bend` files are left byte-exact on purpose: `native.ts` hashes them into its
native-lane cache key, so any edit is a deliberate policy change, not a comment.

## Ported gates

The proof obligations are not inherited as files only: the gates that run them are
ported too, with their fixtures pointed at `src/core`.

| Workspan | Upstream | Change |
| --- | --- | --- |
| `scripts/bend-toolchain.{json,mjs,d.mts}` | same | none — one owner for the pin |
| `scripts/install-bend-ci.sh` | same | none |
| `scripts/bend-entry.ts`, `scripts/build-bend.mjs` | same | sources read from `src/core`, artifact written to `src/core/generated` |
| `test/proof-gate.test.ts` | same | fixture copies the five `.bend` files from `src/core` |
| `test/build-gate.test.ts` | same | fixture mirrors the `src/core` layout |
| `test/native.test.ts` | same | import paths only |

`audit.test.ts` was **not** ported: it exercises the Pi extension and the label
registry (`extension.ts`, `labels.ts`), which Workspan deliberately does not have.
The audit lane itself (`auditTurnReceipts`) is reachable from `src/core/native.ts`
and is covered by `test/native.test.ts`; wiring it to adapters is still open.

## Adapted, not copied

| Workspan | Upstream | Why |
| --- | --- | --- |
| `src/core/clock.ts` | `automatic.ts` | Same interval policy, but the terminal-input decoder stays in the Pi adapter and persistence goes through the `WindowPort` interface instead of a concrete store |

## What this costs, and how it ends

This is a deliberate fork with a bounded life. Two consequences follow, and both
are requirements rather than observations:

1. **`pi-time-tracker` is frozen for accounting purposes** at the revision above.
   It still runs and still writes its own database; it is not migrated, renamed or
   republished by this project. Editing the upstream copies in parallel would
   recreate the drift this inheritance exists to prevent.
2. **The two ledgers are never added together.** The tracker's database and the
   Workspan daemon's database are separate measures during the transition. The
   duplication ends at the cutover (M4) and the migration (M5), when Pi writes into
   the daemon instead of its own file and the history is reconciled under approval.

Until then, `docs/architecture.md` in the tracker sibling remains the record of
what the frozen implementation does.
