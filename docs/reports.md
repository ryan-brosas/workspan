# Day, week and export

```sh
workspan day --date 2026-10-03 --tz Asia/Kathmandu
workspan week --date 2026-10-03 --tz UTC
workspan day --date 2026-10-03 --tz UTC --json
workspan week --date 2026-10-03 --tz UTC --export csv > week.csv
workspan day --date 2026-10-03 --export md > day.md
```

`day` and `week` both fetch the paged protocol method `report` underneath, so a
large report pages automatically instead of failing the frame limit; the CLI flags
(`--date`, `--tz`, `--json`, `--export csv|md`) are identical for both.

A week is local Monday through Sunday containing the supplied date (today if
omitted); the default timezone is the daemon host's IANA zone. Days use exact
calendar boundaries, including fractional UTC offsets and 23/25-hour DST days.
Invalid or skipped local dates are rejected, never normalized into another day.

The daemon owns one attributed evidence projection. Status, day and week reuse it;
clipping preserves project/root metadata and overlaps claimed by different clients
stay ambiguous. Every measure and session duration comes from Bend. The weekly
union is computed over the period, not by adding rounded day labels. Attested,
inferred and agent runtime are always separate, never a combined billable figure.

JSON contains exact millisecond totals, project allocation, unallocated roots,
ambiguous time, sessions, the person's notes, annotations and uncovered stretches.
It includes range, timezone, generation time, evidence revision, watermark, policy
identity and idle gap. Coverage counts/conflicts/open turns are ledger-wide; each
local day separately names its event count. Open sessions contribute only separately
marked provisional rows, never finalized attested totals. Sub-minute durations render
as `<1m`, and a span clipped at a local-day boundary ends at `24:00` rather than
repeating `00:00`. Pauses are excluded from
provisional spans as well as closed sessions. Removed sessions stay excluded and
visible as corrections. Warnings name what needs review: collection gaps
(`sampling-gap`, `source-unavailable`, `idle-unavailable`), pending or refused
evidence (`evidence_pending`, `evidence_delivery_needs_review`), open agent turns
(`agent_end_unknown`), open or removed sessions (`provisional_session`,
`removed_sessions`) and conflicts (`conflicting_evidence`).

CSV and Markdown are summary tables over the same facts: `union`, `project`,
`unallocated`, `ambiguous` and `provisional_session` rows, with exact `ms`, policy,
watermark and review metadata. **Do not add row kinds, week rows to day rows, or
measures to one another.** Session notes and detailed stretches stay in text/JSON,
not tabular exports. CSV quotes every cell and protects spreadsheet formula prefixes;
Markdown escapes table separators, HTML and link delimiters. Exports are drafts,
not permission to record official or billable hours. Redirected files contain local
metadata (and text/JSON may contain user notes); keep them private.

`report` serves bounded chunks from one immutable snapshot. `WorkspanClient.report`
and `readReport` assemble them; CLI and MCP tool `work_report` do not calculate
anything. A snapshot expires five minutes after the last request that used it, and may
also be evicted when eight snapshots or a combined 16 Mi (2^24) **UTF-16 code-unit**
limit is reached - a code unit is the unit of `String` offsets, so a CJK-heavy report
is larger in bytes than its offsets suggest. A single snapshot exceeding that limit
fails explicitly. An expired report must be restarted rather than mixed with a newer
ledger revision. The legacy `day` protocol method - distinct from the `workspan day`
CLI subcommand above - remains `{date, timezone, text}` for small reports; oversized
legacy replies fail with `response_too_large`, directing clients to the paged method.

`scripts/reconcile-tracker.ts` now clips source windows to each local day, unions
through Bend and compares exact daemon JSON totals. It no longer parses rounded
human labels. The historical comparison in `docs/cutover.md` predates this repair;
it is an observation, not a precise approval gate. Re-run a named range after an
approved deployment/scratch import before considering cutover.
