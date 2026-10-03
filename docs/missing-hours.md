# Why the tracker misses hours

Diagnosis, 2026-10-03, from the live database and ledgers — read-only. This is the
record that motivated the Pi adapter and the attestation design.

## One session, checked from the inside

A continuous working session on 2026-10-03, span 320 minutes:

```
recorded as work:  143 min
recorded as gap:  176 min   excluded
outside capture:    0 min
```

55% of a session the user knows was continuous work is not in the hours.

## The three mechanisms

| Cause | Mechanism | Evidence |
| --- | --- | --- |
| The 15-minute input gap | The clock only advances on human keystrokes (`extension.ts` → `isHumanInput` → `touch`). Over `DEFAULT_IDLE_GAP_MS` (15 min) without one, the window closes and the rest becomes a `gap`, reported as *Unknown (no interval evidence)*. | Same-day daytime gaps, six days: 299, 484, 899, 731, 539, 351 min. This session: 176 min. |
| Pi-terminal-only vision | Anything outside a Pi terminal — editor, browser, design, reading on screen — produces no observation at all. Not even a gap row. | By construction; the desktop collector exists because this signal is unused. |
| Agent runtime is excluded | Correct by doctrine — an agent running is not proof of attendance — but long turns with no keystrokes in between feed cause 1. | This session: long tool runs between prompts. |

## Two traps when reading the numbers

- **Sums lie.** Raw window sums double-count concurrent panes: one day summed to
  5,417 minutes (90 hours). Only the union is real: 1,185 minutes that day. Any
  number that sums windows is inflated; the report unions through Bend.
- **Overnight gaps are not lost work.** Gap rows can span ~1,700 minutes because
  they run from the last observation of one day to the first of the next. The real
  daytime exclusions are the short rows.

## The remedy that already existed, unused

The tracker's designed answer for reading, design and review time is the attested
session: `/work start` … `/work stop`. A grep across every ledger on this machine
found **zero** attested session records, ever. The mechanism that covers exactly
these hours has never been invoked once.

That is a UX failure, not a discipline failure: the remedy lives behind a slash
command in a tool that is meant to fade into the background. The design consequence
for Workspan is explicit —

1. attestation must be one click, not a command (the bar widget's Start session);
2. excluded time must be visible ("3h of this session were not counted"), not silent;
3. presence annotates and never counts, which the collector already refuses to do.

## What the ledger gets right

Recorded hours are not lost or double-counted: the union is sound and the same Bend
policy reconciles byte-identically across a migration. What is missing is *excluded*
time, by policy — which is why the fix is attestation, not a looser gap.

Loosening the idle gap would manufacture hours from absence: 15 minutes of silence
is not proof of anything. The honest answer is to record what was observed, keep the
exclusions reviewable, and let a person state the rest.
