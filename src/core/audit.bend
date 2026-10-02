# Receipt coverage policy. No billing decisions, signing or tamper-proof claims.
# Input: group,durable_ms,interval_count,has_summary,expected_ms,modern,variant
# Output status: 0 consistent, 1 legacy, 2 missing, 3 checkpoint-only,
#                4 mismatch, 5 conflicting summaries.
import Base
import ./batch.bend as Batch

type Row is Data:
  Row{group: Nat, total: Nat, intervals: Nat, present: Nat, expected: Nat, modern: Nat, variant: Nat}

def valid(row: Row, ok: Bool) -> Maybe<&2, Row>:
  match ok:
    case True{}:
      Some{row}
    case False{}:
      None{}

def parse_row(fields: List<&2, String>) -> Maybe<&2, Row>:
  match fields:
    case g <> t <> n <> p <> e <> m <> v <> Nil{}:
      do Maybe<&2, Row>:
        group : Nat <- Nat.read(g)
        +total : Nat <- Nat.read(t)
        +intervals : Nat <- Nat.read(n)
        +present : Nat <- Nat.read(p)
        +expected : Nat <- Nat.read(e)
        +modern : Nat <- Nat.read(m)
        +variant : Nat <- Nat.read(v)
        valid(Row{group, total, intervals, present, expected, modern, variant},
          Bool.and(Bool.and(Nat.is_le(present, 1n), Nat.is_le(modern, 1n)),
            Bool.and(Bool.or(Nat.is_eq(present, 1n), Bool.and(Nat.is_gt(intervals, 0n),
              Bool.and(Nat.is_eq(expected, 0n), Bool.and(Nat.is_eq(modern, 0n), Nat.is_eq(variant, 0n))))),
              Bool.or(Bool.and(Nat.is_eq(intervals, 0n), Nat.is_eq(total, 0n)),
                Bool.and(Nat.is_gt(intervals, 0n), Nat.is_gt(total, 0n))))))
    case _:
      None{}

# Same stack-safe fold as the interval side; a monadic bind nests per line.
def row_update(got: Maybe<&2, Row>, state: Bool & List<&2, Row>) -> Bool & List<&2, Row>:
  match got:
    case None{}:
      (_, out) = state
      (True{}, out)
    case Some{row}:
      (+failed, out) = state
      (failed, row <> out)

# Match a direct parameter before evaluating any fields after a failure.
def parse_step(failed: Bool, line: String, out: List<&2, Row>) -> Bool & List<&2, Row>:
  match failed:
    case True{}:
      (True{}, out)
    case False{}:
      row_update(parse_row(Batch.split(line, ',')), (False{}, out))

def parse_done(failed: Bool, out: List<&2, Row>) -> Maybe<&2, List<&2, Row>>:
  match failed:
    case True{}:
      None{}
    case False{}:
      Some{List.reverse(&2, Row, out)}

def parse(lines: List<&2, String>, state: Bool & List<&2, Row>) -> Maybe<&2, List<&2, Row>>:
  match lines:
    case Nil{}:
      (+failed, out) = state
      parse_done(failed, out)
    case SNil{} <> tail:
      parse(tail, state)
    case line <> tail:
      (+failed, out) = state
      parse(tail, parse_step(failed, line, out))

def group(row: Row) -> Nat:
  match row:
    case Row{g, _, _, _, _, _, _}:
      g

def present(row: Row) -> Nat:
  match row:
    case Row{_, _, _, p, _, _, _}:
      p

def row_le(a: Row, b: Row) -> Bool:
  Nat.is_le(group(a), group(b))

def same_fields(a: Row, b: Row) -> Bool:
  match a b:
    case Row{_, t, n, p, e, m, v} Row{_, bt, bn, bp, be, bm, bv}:
      Bool.and(Nat.is_eq(t, bt), Bool.and(Nat.is_eq(n, bn), Bool.and(Nat.is_eq(p, bp),
        Bool.and(Nat.is_eq(e, be), Bool.and(Nat.is_eq(m, bm), Nat.is_eq(v, bv))))))

def matched(same: Bool) -> Nat:
  match same:
    case True{}:
      0n
    case False{}:
      4n

def covered(intervals: Nat, total: Nat, expected: Nat, modern: Nat) -> Nat:
  match intervals:
    case 0n:
      match modern:
        case 0n:
          1n
        case 1n+p:
          2n
    case 1n+p:
      matched(Nat.is_eq(total, expected))

def has_summary(present: Nat, intervals: Nat, total: Nat, expected: Nat, modern: Nat) -> Nat:
  match present:
    case 0n:
      3n
    case 1n+p:
      covered(intervals, total, expected, modern)

def status_row(row: Row) -> Nat:
  match row:
    case Row{_, t, n, p, e, m, _}:
      has_summary(p, n, t, e, m)

def status(row: Row, conflict: Bool) -> Nat:
  match conflict:
    case True{}:
      5n
    case False{}:
      status_row(row)

def total_text(row: Row) -> String:
  match row:
    case Row{_, t, _, _, _, _, _}:
      Nat.show(t)

def show(+row: Row, copies: Nat, conflict: Bool) -> String:
  Nat.show(group(row)) ++ "," ++ Nat.show(status(row, conflict)) ++ "," ++ total_text(row) ++ "," ++ Nat.show(copies) ++ "\n"

def step(+old: Row, +next: Row, copies: Nat, out: List<&2, String>, conflict: Bool, same_group: Bool) -> Row & Nat & List<&2, String> & Bool:
  match same_group:
    case True{}:
      (old, Nat.add(copies, present(next)), out, Bool.or(conflict, Bool.not(same_fields(old, next))))
    case False{}:
      (next, present(next), show(old, copies, conflict) <> out, False{})

def fold(rows: List<&2, Row>, state: Row & Nat & List<&2, String> & Bool) -> String:
  match rows:
    case Nil{}:
      (row, copies, out, conflict) = state
      Batch.concat_reversed(show(row, copies, conflict) <> out, "")
    case +next <> tail:
      (+old, copies, out, conflict) = state
      fold(tail, step(old, next, copies, out, conflict, Nat.is_eq(group(old), group(next))))

def render(rows: List<&2, Row>) -> String:
  match rows:
    case Nil{}:
      "worktime-audit-v1\n"
    case +row <> tail:
      "worktime-audit-v1\n" ++ fold(tail, (row, present(row), Nil{}, False{}))

# Complete pure boundary; render alone requires already-sorted rows.
def evaluate(text: String) -> Maybe<&2, String>:
  do Maybe<&2, String>:
    rows : List<&2, Row> <- parse(Batch.split(Batch.normalize_crlf(text), '\n'), (False{}, Nil{}))
    return render(Batch.sort(~Row, ~row_le, rows))

def reconcile(result: Maybe<&2, String>) -> IO(Unit):
  match result:
    case None{}:
      IO.die(Unit, 2, "Invalid receipt audit batch")
    case Some{text}:
      IO.write(text)

def run(text: String) -> IO(Unit):
  reconcile(evaluate(text))
