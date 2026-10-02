# Native interval reconciliation. Protocol v1: numeric group,start,end rows.
# No prompts, notes, addresses, network access, clocks or billing policy.
import Base
import ./audit.bend as Audit
import ./batch.bend as Batch

type Span is Data:
  Span{group: Nat, start: Nat, end: Nat}

def valid_span(span: Span, valid: Bool) -> Maybe<&2, Span>:
  match valid:
    case True{}:
      Some{span}
    case False{}:
      None{}

def parse_fields(fields: List<&2, String>) -> Maybe<&2, Span>:
  match fields:
    case g <> s <> e <> Nil{}:
      do Maybe<&2, Span>:
        group : Nat <- Nat.read(g)
        +start : Nat <- Nat.read(s)
        +end : Nat <- Nat.read(e)
        valid_span(Span{group, start, end}, Nat.is_ge(end, start))
    case _:
      None{}

# Fold every row without a monadic bind: a bind would nest one closure per
# line and overflow the JS stack on a year of receipts. Tail recursion only.
def span_update(got: Maybe<&2, Span>, state: Bool & List<&2, Span>) -> Bool & List<&2, Span>:
  match got:
    case None{}:
      (_, out) = state
      (True{}, out)
    case Some{span}:
      (+failed, out) = state
      (failed, span <> out)

# Match a direct parameter before evaluating any fields after a failure.
def parse_step(failed: Bool, line: String, out: List<&2, Span>) -> Bool & List<&2, Span>:
  match failed:
    case True{}:
      (True{}, out)
    case False{}:
      span_update(parse_fields(Batch.split(line, ',')), (False{}, out))

# Bend 2.0.7 rejects a match on a binder captured from a destructured parameter,
# so the final decision lives in its own def and the fold only forwards the state.
def parse_done(failed: Bool, out: List<&2, Span>) -> Maybe<&2, List<&2, Span>>:
  match failed:
    case True{}:
      None{}
    case False{}:
      Some{List.reverse(&2, Span, out)}

def parse_lines(lines: List<&2, String>, state: Bool & List<&2, Span>) -> Maybe<&2, List<&2, Span>>:
  match lines:
    case Nil{}:
      (+failed, out) = state
      parse_done(failed, out)
    case SNil{} <> rest:
      parse_lines(rest, state)
    case line <> rest:
      (+failed, out) = state
      parse_lines(rest, parse_step(failed, line, out))


def span_le(a: Span, b: Span) -> Bool:
  match a b:
    case Span{+ga, sa, _} Span{+gb, sb, _}:
      Bool.or(Nat.is_lt(ga, gb), Bool.and(Nat.is_eq(ga, gb), Nat.is_le(sa, sb)))

def max_nat(a: Nat, b: Nat, first: Bool) -> Nat:
  match first:
    case True{}:
      a
    case False{}:
      b

def merge_head(next: Span, last: Span, tail: List<&2, Span>, overlaps: Bool) -> List<&2, Span>:
  match next last overlaps:
    case Span{g, s, e} Span{lg, ls, le} False{}:
      Span{g, s, e} <> Span{lg, ls, le} <> tail
    case Span{_, _, +ne} Span{g, s, +e} True{}:
      Span{g, s, max_nat(e, ne, Nat.is_ge(e, ne))} <> tail

def push_span(next: Span, acc: List<&2, Span>) -> List<&2, Span>:
  match next acc:
    case Span{g, s, e} Nil{}:
      [Span{g, s, e}]
    case Span{+g, +s, e} Span{+lg, ls, +le} <> tail:
      merge_head(Span{g, s, e}, Span{lg, ls, le}, tail,
        Bool.and(Nat.is_eq(g, lg), Nat.is_le(s, le)))

def merge_all(spans: List<&2, Span>, acc: List<&2, Span>) -> List<&2, Span>:
  match spans:
    case Nil{}:
      acc
    case span <> tail:
      merge_all(tail, push_span(span, acc))

def row(group: Nat, total: Nat) -> String:
  Nat.show(group) ++ "," ++ Nat.show(total) ++ "\n"

def group_step(g: Nat, total: Nat, ng: Nat, duration: Nat, out: List<&2, String>, same: Bool) -> Nat & Nat & List<&2, String>:
  match same:
    case True{}:
      (g, Nat.add(total, duration), out)
    case False{}:
      (ng, duration, row(g, total) <> out)

def totals(spans: List<&2, Span>, state: Nat & Nat & List<&2, String>) -> String:
  match spans:
    case Nil{}:
      (g, total, out) = state
      Batch.concat_reversed(row(g, total) <> out, "")
    case Span{+ng, s, e} <> tail:
      (+g, total, out) = state
      totals(tail, group_step(g, total, ng, Nat.sub(e, s), out, Nat.is_eq(g, ng)))

def render(spans: List<&2, Span>) -> String:
  match spans:
    case Nil{}:
      "worktime-v1\n"
    case Span{g, s, e} <> tail:
      "worktime-v1\n" ++ totals(tail, (g, Nat.sub(e, s), Nil{}))

# Complete pure boundary shared by the native CLI and generated JS.
# Keep validation, ordering and union here, not in host-language callers.
def evaluate(text: String) -> Maybe<&2, String>:
  do Maybe<&2, String>:
    spans : List<&2, Span> <- parse_lines(Batch.split(Batch.normalize_crlf(text), '\n'), (False{}, Nil{}))
    return render(merge_all(Batch.sort(~Span, ~span_le, spans), Nil{}))

def reconcile(result: Maybe<&2, String>) -> IO(Unit):
  match result:
    case None{}:
      IO.die(Unit, 2, "Invalid interval batch")
    case Some{text}:
      IO.write(text)

def dispatch(audit: Bool, text: String) -> IO(Unit):
  match audit:
    case True{}:
      Audit.run(text)
    case False{}:
      reconcile(evaluate(text))

def read_text(text: String, within_limit: Bool, audit: Bool) -> IO(Unit):
  match within_limit:
    case True{}:
      dispatch(audit, text)
    case False{}:
      IO.die(Unit, 2, "Interval batch exceeds the 8 MiB limit")

def read_done(pair: File & Result<&1, &1, U32 & String, String>, audit: Bool) -> IO(Unit):
  (file, result) = pair
  do IO<Unit>:
    File.close(file)
    +text : String <- IO.pass(String, result)
    read_text(text, Nat.is_lt(String.length(text), 8388608n), audit)

def read_input(path: String, audit: Bool) -> IO(Unit):
  do IO<Unit>:
    file : File <- IO.try(File, File.open(path, "r"))
    pair : File & Result<&1, &1, U32 & String, String> <- File.read(file, 8388608)
    read_done(pair, audit)

def audit_mode(path: String, valid_mode: Bool) -> IO(Unit):
  match valid_mode:
    case True{}:
      read_input(path, True{})
    case False{}:
      IO.die(Unit, 2, "Unknown worktime engine mode")

def run(args: List<String>) -> IO(Unit):
  match args:
    case path <> Nil{}:
      read_input(path, False{})
    case path <> mode <> Nil{}:
      audit_mode(path, String.eq(mode, "audit"))
    case _:
      IO.die(Unit, 2, "Usage: worktime-engine INPUT_FILE [audit]")

def main() -> IO(Unit):
  do IO<Unit>:
    args : List<String> <- IO.args()
    run(args)
