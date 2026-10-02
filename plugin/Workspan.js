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
 * The bar shows the strongest attended evidence, never a sum of measures: an
 * agent running unattended must not read as time worked.
 */
function barLabel(status) {
  if (!status) return "--"
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

function projectLines(m, extras) {
  var lines = m.projects.map(function (row) { return row.project + " " + formatDuration(row.ms) })
  if (m.unallocatedMs > 0) lines.push("unallocated " + formatDuration(m.unallocatedMs))
  if (m.ambiguousMs > 0) lines.push("ambiguous " + formatDuration(m.ambiguousMs))
  return lines.concat(extras || [])
}

/** Rows for the popup body: one per measure, in a fixed order. */
function displayRows(status) {
  var specs = [["attested", "Attested session"], ["inferred", "Inferred attended"], ["agent", "Agent runtime"]]
  var rows = []
  for (var i = 0; i < specs.length; i++) {
    var m = measure(status, specs[i][0])
    rows.push({ key: specs[i][0], label: specs[i][1], value: formatDuration(m.unionMs), projects: projectLines(m, []) })
  }
  return rows
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
  return project + " - " + formatDuration(session.provisional_ms) + " provisional"
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
  if (state === "stale") lines.unshift("Workspan: daemon not writing")
  return lines.join("\n")
}

/** Bounded, content-free message from a failed CLI run. */
function shortMessage(text) {
  var value = String(text || "").trim().split("\n")[0]
  if (value.length > 160) value = value.slice(0, 160) + "..."
  return value
}
