import Base
import ./audit.bend as Audit
import ./LAWS.bend as Laws

def nat_self_equal(+n: Nat) -> {True{} == Nat.is_eq(n, n) : Bool}:
  match n:
    case 0n:
      {==}
    case 1n+p:
      nat_self_equal(p)

def Laws.conflict_wins(row):
  {==}

def Laws.checkpoint_only(intervals, total, expected, modern):
  {==}

def Laws.modern_missing(total, expected, modern):
  {==}

def Laws.legacy_without_intervals(total, expected):
  {==}

# Unfolding covered(1n+tail, total, total, modern) eliminates tail and modern.
# The rewrite motive's _ marks Nat.is_eq(total, total), not an inference hole.
def Laws.matching_evidence(tail, total, modern):
  %nat_self_equal(total) : {Audit.matched(_) == 0n : Nat}
  {==}
