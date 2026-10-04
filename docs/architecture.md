# Workspan architecture

Status: implemented and deployed on this host (2026-10-04); this document remains the
architecture of record. Research date: 2026-10-02 UTC.

Audience: the next engineer implementing Workspan. [Research and Sourcebot receipts](research-2026-10-02.md) contain pinned evidence, licenses and verification limits. [Dot research](dot-time-tracking-research-2026-10-02.md) owns the cloud-client investigation.

## Decision in brief

Keep the accounting backend, change who hosts it. Start with a standalone TypeScript daemon using the existing SQLite and generated Bend policy, plus a Rust desktop collector. Pi and Omarchy become clients. Do not make the desktop shell responsible for persistence or reconstruct working hours from agent runtimes.

Rust has a concrete first responsibility: native desktop events and lifecycle handling. It does not need to replace tested database/report code to be useful. A Rust daemon calling a prebuilt Bend executable is a credible later packaging option, not a prerequisite for independence from Pi.

“Tom's version” still needs confirmation. Both `monotykamary/bend` and `monotykamary/varve` were researched. The observed Bend fork head is 34 commits behind the tracker's existing compiler pin, with no unique commits in that comparison. Do not downgrade to it just because it is a fork. Varve is a separate database decision, not the current storage backend.

## 1. What exists and what actually needs changing

The current tracker is clean at `931c74c024a24ae7800a66fe21bccecbf19a945b`.

- Bend owns interval union and receipt classification. `native.ts` validates transport and calls generated JS by default or an explicitly selected native executable.
- SQLite WAL with `synchronous=FULL` owns workspace mappings and inferred windows. Independent agent/session receipts also exist as JSONL. It would be inaccurate to describe today's data as already unified in one SQLite event ledger.
- `ProjectStore`, `AutomaticClock` and `buildAutomaticReport` are public exports, but the package root also imports the Pi extension. `automatic.ts` imports Pi TUI key decoding. Public exports are not yet a clean Pi-free runtime entry point.
- Pi lifecycle callbacks drive capture. Keeping a conversation open does not itself establish work. The current clock bounds windows by observed input and marks long gaps.

The smallest extraction is a Pi-free core entry point, with terminal-input decoding left in the Pi adapter. A proposed `pi-time-tracker/core` export would make that seam explicit; it does not exist yet. Keep shared implementation in one owning package initially. Do not copy the Bend rules into Workspan, port their arithmetic into Rust, or maintain two independent report engines.

Moving the shared package's repository/name can follow a verified compatibility release. It should not be bundled with the first daemon, desktop installation and history migration.

## 2. Proposed first shipping shape

```text
Pi adapter    Codex adapter    Rust collector    Omarchy QML
    |              |               |                 |
    |              |               |            Workspan CLI
    +--------------+---------------+-----------------+
                           |
                 private local IPC socket
                           |
               Workspan daemon: TypeScript
               validation / commands / reports
                    |                 |
             SQLite authority    shared Bend policy
             events + state      generated JS artifact
```

### Ownership

| Component | Owns | Must not own |
| --- | --- | --- |
| Shared accounting package | Bend sources, tested host conversion, reconciliation and report semantics | Pi callbacks, desktop UI, vendor authentication |
| Daemon | Validated ingestion, transactions, session commands, project assignments, projections, report snapshots | Provider-specific content parsing or alternative interval math |
| Rust collector | Native capability discovery, coarse presence/idle/lock/suspend metadata, reconnect behavior | Working-hour totals or silently interpreting idle as a break |
| Pi/Codex adapters | Source normalization, stable identities, permitted metadata, replay checkpoints | Their own authoritative totals or automatic client assignment |
| CLI | Local protocol client, structured output, explicit controls | A second database writer |
| Omarchy plugin | Current session, controls, coverage warnings, rendering | Owning a timer's durable state or directly opening SQLite |

Use one daemon per user, not one per Pi pane/project. A user service is the intended Linux deployment boundary, but enabling it requires separate approval. The shell can reload, Pi can close, and clients can reconnect without stopping an explicitly opened session.

Keep the first source layout modest: daemon/CLI code, adapters, one Rust collector crate, the Omarchy integration and docs. Do not create a plugin marketplace, remote service, microservice cluster or arbitrary executable plugin loader.

## 3. Keep the measures separate

1. **Attested sessions:** the user explicitly states they worked during an interval. Reading/design work without input can belong here.
2. **Inferred attended windows:** trusted interaction evidence supports a window under a visible, versioned policy. Work between questions can belong here; the measure is not AI response duration.
3. **Agent runtime:** a tool/agent was running. It is useful operational evidence, not proof of attendance.
4. **Coverage diagnostics:** missing ends, clock anomalies, offline collectors and unknown attribution. These are not a fourth hours total.

Never add the first three measures together. Union overlaps across tools within each measure. Source breakdowns can overlap and must be labeled non-additive.

A first inference policy can preserve the existing 15-minute gap setting while making it configurable and visible. This is an inference setting, not a rule that someone stopped working after fifteen minutes. Long gaps remain reviewable; explicit session attestation can cover them. Desktop idle is an annotation, not automatic deletion of design time.

Example: an attested 10:00–11:00 session, Pi evidence during 10:05–10:35, Codex evidence during 10:20–10:50 and an agent running until 12:00 must never produce a 3-hour work total. The report shows each measure separately and explains its evidence.

### Project conflicts need their own policy

Deduplicating per project is insufficient: simultaneous claims for two clients can still inflate the sum of client totals. Partition the global within-measure union at assignment boundaries. Each resulting segment is assigned once, unallocated, or explicitly ambiguous.

Use an explicit selected session/project or a confirmed source-session/root mapping. App focus is only a hint. A cloud thread without a mapping stays unallocated. Conflicting explicit assignments require review; do not resolve them by arrival order, app name or arbitrary percentages.

Required invariant: allocated project duration plus unallocated/ambiguous duration equals the global union for that measure. A person cannot bill the same segment to two projects automatically.

## 4. Evidence contract and storage

Use a versioned, allowlisted event envelope rather than accepting arbitrary vendor JSON. Proposed fields:

| Field group | Purpose |
| --- | --- |
| `schema_version`, `event_kind` | Reject unsupported semantics instead of guessing |
| `source_namespace`, `source_instance_id` | Separate adapters/accounts/devices without storing credentials |
| `source_session_id`, `source_event_id` | Stable source identity; not a received-at timestamp |
| `occurred_at_ms`, `received_at_ms` | UTC event time versus transport arrival time |
| `boot_id`, optional monotonic time | Detect local clock/suspend discontinuities; not comparable across machines/boots |
| `origin` | Human, automated, user-attested or unknown, with the adapter's evidence basis |
| optional `project_id`, `mapping_revision` | Explicit attribution and the mapping used |
| bounded metadata fingerprint | Detect conflicting duplicates without storing content |

Events include human interaction, agent-turn start/end, explicit session commands and source-health transitions. A later turn completion is a separate event, not a conflicting overwrite of its start. Received-at time and retry counters must not affect the identity/fingerprint of the original observation.

Proposed logical tables, implemented only when their owning slice needs them:

- `observations`: immutable normalized metadata with a unique source-event key.
- `source_state`: committed replay cursor, last successful delivery and coverage state.
- `sessions` plus session transitions: the user's current explicit session and revisioned history.
- `project_bindings`: user-confirmed mapping history, not a guessed global client name.
- `corrections`: explicit supersession/assignment/attestation with provenance; no silent receipt edits.
- derived interval/report projections: keyed by input watermark and policy version, rebuildable from accepted evidence.

SQLite remains the canonical local transactional store. Adapter retry spools are transport buffers, not competing time ledgers. Keep old JSONL receipts as migration inputs/provenance until an approved migration has been verified.

### Replay and acknowledgement

1. A non-replayable source persists its small metadata event to a private spool before attempting delivery. A replayable importer preserves the upstream cursor until acknowledgement.
2. The daemon validates the envelope, size/range limits and identity.
3. In one transaction it accepts the event and commits the corresponding cursor/projection invalidation. It acknowledges only after commit.
4. A duplicate identity with identical canonical metadata returns the previous receipt. A duplicate identity with different metadata is a conflict, not a replacement.
5. The adapter removes acknowledged spool entries only after that durable receipt. If the response is lost, replay is safe.

This is at-least-once delivery with an idempotent accounting effect, not a promise of exactly-once transport. Health/liveness heartbeats are never human-work evidence. Backpressure and disk-full failures remain visible; they do not silently discard unacknowledged observations. Any retention/size limit needs a reported coverage-loss state.

## 5. Session state and time behavior

The daemon serializes explicit session commands. Use an expected state revision to prevent two UIs from racing `start`, `pause` or `switch-project`.

```text
stopped -> running -> paused -> running -> stopped
                 \-> needs-review after discontinuity
```

Only one current explicit project session exists per user in the initial model. Switching projects closes the old segment and opens the new one atomically. Historical corrections are separate explicit actions.

- Wall-clock UTC milliseconds support records and reporting. Use integer bounds compatible with the existing Bend transport, not floats for duration accumulation.
- Monotonic observations help detect clock changes within a boot. They do not justify counting suspend time, another machine's time, or an unattended process as work.
- A shell/Pi exit is not a user stop. A daemon crash/reboot is not permission to extend an inferred window to “now.” Recover durable state and mark the uncertain tail for review.
- An explicit open session can display a provisional elapsed value. Final export must distinguish that from a user-confirmed closed interval and flag any recovery gap.
- Lock/idle/suspend transitions annotate or mark review boundaries. Automatic pause is optional only under an explicitly selected policy, never the hidden default.
- Inference replay sorts source event time and recomputes affected bounded windows. Do not feed old history into `AutomaticClock.touch` as though it were live input.
- Reports choose timezone and work-session range explicitly, then split calendar boundaries. DST and overlapping selected ranges require regression tests. Store UTC; do not bake a company's shift schedule into the core.

## 6. Local IPC and desktop interface

First target: a Unix-domain socket in `$XDG_RUNTIME_DIR/workspan/`, with a private directory and socket permissions. Use a bounded versioned request/response protocol and a status subscription. No network listener or browser-accessible API is needed initially.

Proposed operations: ingest a batch, start/pause/resume/stop/switch a session, read status, subscribe to status changes, preview a report and submit an explicit correction. These names are design contracts, not implemented public methods.

Requests have correlation IDs; mutating commands have idempotency keys and expected revisions. Status includes the projection watermark/policy version, pending events and source coverage. A stale/disconnected UI must say so rather than continue presenting a locally invented authoritative total. Reconnection obtains a fresh snapshot before applying subsequent updates.

Same-user socket access is not protection from malicious code already running as that user. Do not present it as cryptographic proof of human attendance. If a future browser or cross-user client requires HTTP, add explicit authentication and origin/host protections then; loopback alone is insufficient.

The installed Omarchy shell is Quickshell. Its user plugins hot-reload independently of the daemon. Build a thin QML view that uses the CLI/protocol, not a new Tauri/Electron app by default. Reuse installed shell components and theme bindings when visual implementation is authorized. Launch commands as executable plus arguments, not interpolated shell text.

The first UI needs the selected project, explicit session state, separated totals, pending/unallocated evidence and source-health warnings. It should work when Pi is closed. No new visual system or desktop configuration is created by this design.

## 7. Adapters and privacy

### Pi

Preserve current callbacks and cancelled-session-switch behavior. Terminal key decoding stays in the adapter; emit coarse presence, never keys or prompt bodies. Avoid depending on Pi's open process lifetime as duration. On cutover, the adapter talks to the daemon instead of continuing its old independent writes for the same evidence.

### Local Codex

Use a verified supported source for the installed version, with stable thread/turn/event IDs and explicit project mapping. Prefer metadata-only API projections or a reviewed metadata-only hook when those actually provide the required fields. Neither starting an app-server nor subscribing to history is assumed side-effect-free without a probe.

Public protocol source has `itemsView: notLoaded`, optional timestamps and pagination. Omission of items is a privacy projection, not itself a coverage failure. Turn timing can describe agent runtime without revealing whether a human initiated it. Codex's `User` origin includes unclassified input; scheduled-heartbeat exclusion alone does not certify a human. Trust only a verified human-origin signal for inferred attendance; otherwise retain unknown origin or use explicit sessions.

Do not parse whole conversation logs and claim the process was metadata-only because it discarded text afterward. If an authorized adapter must transiently inspect content-bearing records, that needs a separate documented privacy decision before implementation or use.

### Dot

Not automatically solved by local Codex or desktop focus. The supported event route, account eligibility, origin coverage and replay behavior remain unresolved. Until verified, offer a selected/attested session with a visible coverage limitation. No private endpoint scraping, token extraction, room creation or read-state changes.

### Desktop

Rust handles native Wayland capabilities plus lock/suspend signals. Use coarse app identifiers only when enabled, not titles, URLs, screenshots, keystrokes or clipboard contents. Capability absence means unavailable, not zero activity. The proposed collector still needs a probe against the installed Hyprland version; a reference repository's support table is not a host test.

Across all adapters, privacy filtering happens before persistence and logs. Keep database/spool files private, bound error messages, and do not include raw event bodies in diagnostics. Checksums detect accidental/conflicting data; they are not notarization. No cloud sync or model-based automatic attendance classification in v1.

## 8. Bend, Rust and storage alternatives

| Option | Assessment |
| --- | --- |
| TypeScript daemon + SQLite + generated Bend + Rust collector | Recommended first. Reuses existing behavior and gives Rust a useful native boundary. Node runtime remains a packaging cost. |
| Rust daemon + SQLite + prebuilt Bend batch executable | Good later option if removing the JS runtime is a real distribution requirement. Requires host/projection migration and cross-backend parity, not a rewrite of accounting policy. |
| Rust embedding the generated JS policy | Possible in principle; engine/module/value compatibility is unproven. Adds a JS runtime boundary without obviously improving the first slice. Defer. |
| Rust calling a bespoke C ABI extracted from Bend internals | Reject for v1. The inspected effects guide explicitly makes no ABI promise. |
| Varve replacing SQLite | Defer. Single-writer IPC removes the old multi-process lock objection, but it does not establish transactional ledger fit, operational qualification or migration value. |
| All-Bend application host or a new database engine | No demonstrated need. Keep pure policy separate from OS, persistence and UI effects. |

The current compiler-free artifact is real: `scripts/build-bend.mjs` builds it with the pinned compiler plugin at build time; `native.ts` loads it at runtime. One delegated research conclusion incorrectly implied JS embedding always needs the compiler at runtime. That conclusion was rejected after checking these files.

For a later Rust host, reuse the existing native protocol rather than inventing an FFI: a prebuilt pinned executable receives a private numeric input file and returns `worktime-v1` / `worktime-audit-v1` output. Today's caller uses `--threads 1 -- <file> [audit]`, a 15-second timeout and a batch cap just below 8 MiB. Stdio framing/persistent workers would be new protocols, not existing features. Call in bounded report/reconciliation batches, not once per keystroke. Compiler and Clang belong in builds, not end-user startup. Pin the compiler, policy source and artifact digest together.

Keep the same Bend source and test corpus across generated/native lanes. An explicitly selected engine failure must remain visible; never silently substitute a second implementation. Existing proofs cover receipt classification, not universal interval-union correctness, database durability, IPC, human provenance or clock behavior. New claims require their own laws/proofs and integration tests.

## 9. Delivery sequence and rollback

**M1: Pi-free local vertical slice.** Extract the core entry point/input-decoder boundary. Run a manually launched daemon in an isolated fixture, accept synthetic events and render the three measures with Pi closed. Do not import live history or enable a service. Preserve the installed tracker.

**M2: Durable ingestion and reports.** Add the minimal event schema, acknowledgements, identity/conflict handling, replay cursor and report watermark. Prove duplicates, lost responses and restart behavior before any adapter uses live records.

**M3: Useful desktop controls.** Add the Rust collector and Omarchy/CLI controls. Test absent Wayland capabilities, reconnect and shell reload. Implementation and installation are separate approvals.

**M4: Pi and local Codex cutover.** Prove metadata-only source receipts and project isolation first. Shadow-compare on synthetic or separately approved snapshots. Select one writer per evidence source at the boundary; do not leave two active ledgers and add their totals.

**M5: Approved migration.** Back up SQLite using a consistent SQLite backup mechanism, not a bare copy of a live WAL database. Preserve original JSONL, import into a separate target with stable migration identities, reconcile counts/intervals and obtain approval before switching. Rollback preserves newly accepted daemon events for replay; it is not simply restoring an old backup over new data.

**M6: Optional Rust host or Dot connector.** Advance only when its separate compatibility/source gate is satisfied. Neither blocks a useful independent tracker.

No push, publication, installation, service enablement, official-hours change or external tracker update is included in this research task.

## 10. Acceptance ledger for implementation

These checks are requirements, not tests run in this session.

- Replaying an event repeatedly changes neither stored identity count nor hours; changed metadata under that identity creates a visible conflict.
- Crash before commit, after commit but before response, and after acknowledgement before spool cleanup all recover without double counting or silent loss.
- Concurrent Pi/Codex/desktop evidence unions once within a measure; project allocation never exceeds the global union.
- Scheduled wakeups, unattended agents and liveness heartbeats never become attended work.
- Design/reading without typing can be included through explicit attestation; idle metadata does not silently subtract it.
- Missing timestamps, late/out-of-order events, backward clock, suspend/reboot and collector disconnect remain distinguishable and reviewable.
- Restarting Omarchy or Pi preserves daemon session state; racing controls produce a revision conflict, not two active sessions.
- A fixture containing synthetic prompts, titles, URLs and keys leaves none in the database, spools, reports or error logs.
- Metadata-only Codex reads omit item bodies, respect installed-version behavior and produce no unwanted thread/room mutations; Dot coverage is claimed only after its own receipt probe.
- Existing Pi fixtures preserve report semantics, source identity and history. Generated/native Bend paths agree through their real host callers; native failure cannot fall back silently.
- Report previews identify timezone, window, policy version, watermark, provisional tails, coverage and ambiguous project segments.
- A clean end-user artifact runs without the Bend compiler. Startup, memory, reconnect and report latency are measured before adopting a heavier runtime or promising performance.
