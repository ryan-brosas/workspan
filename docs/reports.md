# Day, week and export

```sh
workspan day --date 2026-10-03 --tz Asia/Kathmandu
workspan week --date 2026-10-03 --tz UTC
workspan day --date 2026-10-03 --tz UTC --json
workspan week --date 2026-10-03 --tz UTC --export csv > week.csv
workspan day --date 2026-10-03 --export md > day.md
```

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
marked provisional rows, never finalized attested totals. Pauses are excluded from
provisional spans as well as closed sessions. Removed sessions stay excluded and
visible as corrections. Collection gaps and pending/refused evidence remain warnings.

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
anything. A snapshot expires after five minutes and may be evicted when eight
snapshots or a combined 16 Mi-character limit is reached. A single snapshot exceeding
that limit fails explicitly. An expired report must be restarted rather than mixed
with a newer ledger revision. Legacy `day` remains `{date, timezone, text}` for small
reports; oversized legacy replies fail with `response_too_large`, directing clients
to the paged method.

`scripts/reconcile-tracker.ts` now clips source windows to each local day, unions
through Bend and compares exact daemon JSON totals. It no longer parses rounded
human labels. The historical comparison in `docs/cutover.md` predates this repair;
it is an observation, not a precise approval gate. Re-run a named range after an
approved deployment/scratch import before considering cutover.
