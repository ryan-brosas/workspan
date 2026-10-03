.pragma library

// Pure helpers for the Workspan bar widget: no QML types, no I/O, so the whole
// file is testable with `node --test` (see tests/workspan.test.mjs).

var NON_ADDITIVE = "Attested, inferred and agent runtime are separate measures. They are never added together."

/** Resolve a configured path, honouring ~ and falling back to the daemon default. */
function expandPath(value, fallback, home) {
  var raw = value === undefined || value === null ? "" : String(value).trim()
  if (raw === "") raw = String(fallback || "")
  if (raw === "~") return String(home || "")
  if (raw.indexOf("~/") === 0) return String(home || "") + raw.slice(1)
  return raw
}

/** Parse a status file. Anything unreadable is "no status", never a fabricated one. */
function parseStatus(text) {
  try {
    var value = JSON.parse(String(text || ""))
    return value && typeof value === "object" && !Array.isArray(value) ? value : null
  } catch (error) { return null }
}

function number(value) {
  var n = Number(value || 0)
  return isFinite(n) && n > 0 ? Math.round(n) : 0
}

function measure(status, name) {
  var source = status && status.measures ? status.measures[name] : null
  var projects = source && Array.isArray(source.projects) ? source.projects : []
  return {
    unionMs: number(source ? source.union_ms : 0),
    unallocatedMs: number(source ? source.unallocated_ms : 0),
    ambiguousMs: number(source ? source.ambiguous_ms : 0),
    projects: projects
      .map(function (row) { return { project: String(row && row.project || ""), ms: number(row && row.ms) } })
      .filter(function (row) { return row.project !== "" })
  }
}

/** "1h 05m" - the popup, where the unit matters. */
function formatDuration(ms) {
  var minutes = Math.round(number(ms) / 60000)
  var hours = Math.floor(minutes / 60)
  var rest = minutes % 60
  if (hours <= 0) return rest + "m"
  return hours + "h " + (rest < 10 ? "0" + rest : String(rest)) + "m"
}

/** "1:05" - the bar, where space does not. */
function formatClock(ms) {
  var minutes = Math.round(number(ms) / 60000)
  var hours = Math.floor(minutes / 60)
  var rest = minutes % 60
  if (hours <= 0) return rest + "m"
  return hours + ":" + (rest < 10 ? "0" + rest : String(rest))
}

/**
 * "1h\n05m" - a vertical bar is one widget wide, so a duration stacks the same
 * way the stock clock stacks its lines. Fixed-square widgets clip anything
 * longer than two characters against the bar edge.
 */
function verticalClock(ms) {
  var minutes = Math.round(number(ms) / 60000)
  var hours = Math.floor(minutes / 60)
  var rest = minutes % 60
  if (hours <= 0) return rest + "m"
  return hours + "h\n" + (rest < 10 ? "0" + rest : String(rest)) + "m"
}

function barLabelVertical(status) {
  if (!status) return "--"
  var session = status.current_session
  if (session) return verticalClock(session.provisional_ms)
  var attested = measure(status, "attested").unionMs
  var inferred = measure(status, "inferred").unionMs
  return verticalClock(attested > inferred ? attested : inferred)
}

/**
 * The bar shows a running session's provisional clock while one is open, and the
 * strongest attended measure otherwise - never a sum of measures, so an agent
 * running unattended must not read as time worked. Provisional is honest: the
 * interval is not final until the session stops, and it freezes while paused.
 */
function barLabel(status) {
  if (!status) return "--"
  var session = status.current_session
  if (session) return formatClock(session.provisional_ms)
  var attested = measure(status, "attested").unionMs
  var inferred = measure(status, "inferred").unionMs
  return formatClock(attested > inferred ? attested : inferred)
}

function ageSeconds(status, nowMs) {
  if (!status || typeof status.generated_at !== "number") return null
  return Math.max(0, Math.round((Number(nowMs) - status.generated_at) / 1000))
}

/** "missing" (no usable status), "stale" (the daemon stopped writing), or "fresh". */
function staleness(status, nowMs, refreshSeconds) {
  var age = ageSeconds(status, nowMs)
  if (age === null) return "missing"
  var limit = Math.max(60, number(refreshSeconds) * 3)
  return age > limit ? "stale" : "fresh"
}

function isOffline(status, nowMs, refreshSeconds) {
  return staleness(status, nowMs, refreshSeconds) !== "fresh"
}

/** Caveats that belong to a measure but are not projects: unallocated, ambiguous. */
function measureCaveats(m) {
  var out = []
  if (m.unallocatedMs > 0) out.push("unallocated " + formatDuration(m.unallocatedMs))
  if (m.ambiguousMs > 0) out.push("ambiguous " + formatDuration(m.ambiguousMs))
  return out
}

/** Rows for the popup body: one measure per row, each project on its own row. */
function displayRows(status) {
  var specs = [["attested", "Attested session"], ["inferred", "Inferred attended"], ["agent", "Agent runtime"]]
  var rows = []
  for (var i = 0; i < specs.length; i++) {
    var m = measure(status, specs[i][0])
    rows.push({ key: specs[i][0], label: specs[i][1], value: formatDuration(m.unionMs), projects: m.projects, caveats: measureCaveats(m) })
  }
  return rows
}

/**
 * Which engine produced these numbers. The arithmetic is Bend policy; saying so
 * is the difference between a number you can audit and a number you trust.
 */
function engineLine(status) {
  var engine = status ? status.engine : null
  if (!engine || !engine.label) return ""
  var parts = []
  if (engine.version) parts.push("Bend " + String(engine.version))
  parts.push(engine.native ? "native lane" : "generated policy")
  if (engine.digest) parts.push(String(engine.digest).slice(0, 8))
  parts.push("gap " + Math.round(number(status.idle_gap_ms) / 60000) + "m")
  return parts.join(" - ")
}

/**
 * The popup company picker: one row per bound company, the active session's
 * project marked. Clicking starts or switches, so the row never needs to know
 * the difference - the widget decides that.
 */
function companyRows(bindings, status) {
  var rows = []
  var active = status && status.current_session ? String(status.current_session.project || "") : ""
  var seen = {}
  var list = Array.isArray(bindings) ? bindings : []
  for (var i = 0; i < list.length; i++) {
    var project = String(list[i] && list[i].project || "")
    if (project === "" || seen[project]) continue
    seen[project] = true
    rows.push({ project: project, active: project === active })
  }
  return rows.sort(function (a, b) { return a.project.localeCompare(b.project) })
}

/** One line per thing the user must look at; empty means nothing needs review. */
function warnings(status) {
  if (!status) return ["No status yet. Start the daemon: workspan daemon"]
  var out = []
  var coverage = status.coverage || {}
  var conflicts = number(coverage.conflicts)
  if (conflicts > 0) out.push(conflicts + (conflicts === 1 ? " conflicting redelivery" : " conflicting redeliveries") + " need review")
  if (number(coverage.open_agent_turns) > 0) out.push(number(coverage.open_agent_turns) + " agent turn(s) with no end")
  if (number(coverage.open_sessions) > 0) out.push("A session is open: its time is provisional")
  var inferred = measure(status, "inferred")
  if (inferred.unallocatedMs > 0) out.push("Unallocated evidence: " + formatDuration(inferred.unallocatedMs))
  if (inferred.ambiguousMs > 0) out.push("Claimed by two projects: " + formatDuration(inferred.ambiguousMs))
  return out
}

function sessionLine(status) {
  var session = status ? status.current_session : null
  if (!session) return "No session running"
  var project = session.project ? String(session.project) : "unallocated"
  var paused = session.state === "paused" ? " (paused)" : ""
  return project + " - " + formatDuration(session.provisional_ms) + " provisional" + paused
}

function tooltip(status, nowMs, refreshSeconds) {
  var state = staleness(status, nowMs, refreshSeconds)
  if (state === "missing") return "Workspan: no status file" + "\n" + "Left-click for details"
  var lines = [
    "Attested  " + formatDuration(measure(status, "attested").unionMs),
    "Inferred  " + formatDuration(measure(status, "inferred").unionMs),
    "Agent     " + formatDuration(measure(status, "agent").unionMs),
    "Separate measures, never added together."
  ]
  if (status.current_session) {
    var open = status.current_session
    lines.unshift((open.project ? String(open.project) : "unallocated") + " - " + formatDuration(open.provisional_ms) + " provisional" + (open.state === "paused" ? " (paused)" : " (running)"))
  }
  if (state === "stale") lines.unshift("Workspan: daemon not writing")
  return lines.join("\n")
}

/** Bounded, content-free message from a failed CLI run. */
function shortMessage(text) {
  var value = String(text || "").trim().split("\n")[0]
  if (value.length > 160) value = value.slice(0, 160) + "..."
  return value
}
