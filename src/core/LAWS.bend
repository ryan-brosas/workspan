# Receipt classification requirements, not a proof of host IO or interval union.
# Proof-gated: conflict precedence, absent-summary checkpoint, zero-interval
# legacy/missing, and equal-total coverage. status(row, False{}), present-summary
# routing and unequal-total mismatch are covered by tests, not by these laws.
import Base
import ./audit.bend as Audit

law conflict_wins:
  for row: Audit.Row
  {Audit.status(row, True{}) == 5n : Nat}

law checkpoint_only:
  for intervals: Nat
  for total: Nat
  for expected: Nat
  for modern: Nat
  {Audit.has_summary(0n, intervals, total, expected, modern) == 3n : Nat}

law modern_missing:
  for total: Nat
  for expected: Nat
  for modern: Nat
  {Audit.covered(0n, total, expected, 1n+modern) == 2n : Nat}

law legacy_without_intervals:
  for total: Nat
  for expected: Nat
  {Audit.covered(0n, total, expected, 0n) == 1n : Nat}

law matching_evidence:
  for tail: Nat
  for total: Nat
  for modern: Nat
  {Audit.covered(1n+tail, total, total, modern) == 0n : Nat}
