# Workspan

Read [README.md](README.md) for current status and [the architecture](docs/architecture.md) for proposed ownership and acceptance gates. [Source research](docs/research-2026-10-02.md) records the verified `context:workspan` corpus and revision limits. Recheck decisive current source before implementation. The [Dot research](docs/dot-time-tracking-research-2026-10-02.md) records observed behavior, not a working integration.

## Implementation ownership

- Workspan is tool-independent. Omarchy is an optional interface; Pi is one adapter.
- The existing implementation is `../pi-time-tracker/`. Inspect its current source, instructions, and tests before extracting or integrating anything. Preserve its installed behavior and historical time records.
- Keep one accounting/storage authority. Do not duplicate the existing implementation here or create separate per-adapter totals that are later added together.
- Reuse the current TypeScript/SQLite and Bend accounting decisions unless an observed requirement justifies changing them.

## Evidence and privacy

- User-attested sessions, inferred work windows, and agent runtime are distinct measures. Merge concurrent intervals within a measure, never add different measures together.
- Work between questions can be part of an attended session. Agent activity alone does not establish attendance. Preserve uncertain gaps.
- Give imported evidence stable source/session/event identity and explicit project attribution. An application name, cloud thread, or missing cwd is not enough to assign a client.
- Keep metadata only by default. Do not store conversation bodies, screenshots, window titles, URLs, raw tool payloads, credentials, or customer data.
- Treat private client endpoints and local caches as versioned observations, not supported public APIs. Validate event coverage and replay behavior before claiming automatic tracking.

## Verified checks

Run these before treating the workspace as sound. Each was run on this host; the
Bend gates need the pinned toolchain (see [docs/bend.md](docs/bend.md)):

```sh
bash scripts/install-bend-ci.sh ~/.local/share/workspan/bend-ci
export PATH=~/.local/share/workspan/bend-ci/bin:$PATH BEND_SOURCE_DIR=~/.local/share/workspan/bend-ci/source

bun run build:check   # generated policy matches its .bend sources
bun run proof:check   # every stated audit law is proven
bun test              # policy, lane parity, daemon, adapters, widget helpers
bun run check         # types
```

Set the compiler on `PATH`, never `BEND_EXECUTABLE`: that variable selects the
native lane, and the tests asserting the default lane will fail if it is set.

## Repository invariants

- **One accounting authority.** Every measure total comes from Bend through
  `src/core`. Never recompute a total in JavaScript, and never add two measures
  together.
- **One writer.** The daemon owns the database. The CLI and the widget are clients;
  the widget reads `status.json` and runs the CLI as an argv array.
- **Inherited policy is not casually edited.** `src/core/*.bend` and
  `generated/policy.mjs` are inherited and pinned by digest. Changing a
  classification rule means changing the laws and the proof gate with it.
- **Presence is not attendance.** Desktop signals are annotations: they arrive with
  origin `unknown`, they never become inferred work, and a missing capability is
  reported as unavailable rather than as zero activity. The collector reads coarse
  fields only — never titles, descriptions, tags, URLs, keystrokes or the clipboard.
- **Nothing stores content.** No prompts, replies, titles, URLs, credentials or
  tool payloads in the database, spools, status file or logs.
- **The Pi adapter shadows, it never replaces.** It never opens the tracker's
  database, never writes its ledgers, and resolves no client names itself — it sends
  the workspace root and the daemon attributes from bindings. The two ledgers are
  never added together until the cutover removes one writer.
- **Migration never touches the live ledger by accident.** It plans first, imports
  into an explicitly named target, refuses the daemon's own database without an
  explicit flag, and reports whether both imported measures reconcile with the
  source. It imports the tracker's own attribution rather than inventing one, and
  labels it never confirmed stay marked provisional. Imported Pi evidence is agent runtime, never attended work and never
  attributed to a client that no mapping named.
- **Derived views are cached against a watermark, never against the clock.** A
  projection is reused until evidence, policy or the idle gap changes; the live
  fields — generation time and a provisional session duration — are recomputed on
  every read. Caching them would freeze the timer.
- **Notes are the only free text, and only from the person.** A session note is
  user-authored attestation: single line, at most 200 characters, append-only, and
  never auto-captured from titles, prompts, URLs or tool payloads. Everything else
  stays metadata.
- **Uncertainty stays visible.** A stopped daemon, an open turn, a conflict or an
  unallocated segment is reported, never smoothed into a confident number.

## Delivery boundary

Local implementation is separate from enabling a service, modifying desktop or agent configuration, importing live history, or changing official hours. Obtain the applicable approval before those actions. Load the installed Omarchy skill before desktop configuration or plugin installation. No remote push, publication, or release is implied by this project setup.
