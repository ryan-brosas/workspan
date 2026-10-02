import assert from "node:assert/strict"
import fs from "node:fs"
import vm from "node:vm"

// The widget imports Workspan.js as a QML library; here it is evaluated with an
// explicit export list so the same source is testable without QML.
const source = fs.readFileSync(new URL("../Workspan.js", import.meta.url), "utf8")
  .replace(/^\.pragma library\s*/, "")
  + "\nmodule.exports = { NON_ADDITIVE, expandPath, parseStatus, measure, formatDuration, formatClock, barLabel, ageSeconds, staleness, isOffline, displayRows, projectLines, warnings, sessionLine, tooltip, shortMessage }\n"
const sandbox = { module: { exports: {} }, isFinite, Number, Math, JSON, String, Array, Object }
vm.runInNewContext(source, sandbox, { filename: "Workspan.js" })
const W = sandbox.module.exports

const HOUR = 3_600_000
const NOW = 1_700_000_000_000
const status = {
  schema: 1,
  generated_at: NOW - 5_000,
  idle_gap_ms: 900_000,
  measures: {
    attested: { union_ms: 2 * HOUR, projects: [{ project: "coral", ms: 2 * HOUR }], unallocated_ms: 0, ambiguous_ms: 0 },
    inferred: { union_ms: HOUR, projects: [{ project: "coral", ms: HOUR - 600_000 }, { project: "other", ms: 300_000 }], unallocated_ms: 300_000, ambiguous_ms: 0 },
    agent: { union_ms: 4 * HOUR, projects: [{ project: "coral", ms: 4 * HOUR }], unallocated_ms: 0, ambiguous_ms: 0 }
  },
  current_session: null,
  coverage: { events: 12, conflicts: 0, open_agent_turns: 0, open_sessions: 0, sources: [] },
  watermark: { observations: 12, conflicts: 0 },
  non_additive: "separate measures"
}

assert.equal(W.expandPath("", "/run/user/1000/workspan/status.json", "/home/u"), "/run/user/1000/workspan/status.json")
assert.equal(W.expandPath("~/ws/status.json", "/fallback", "/home/u"), "/home/u/ws/status.json")
assert.equal(W.expandPath("/tmp/x.json", "/fallback", "/home/u"), "/tmp/x.json")
assert.equal(W.parseStatus("not json"), null)
assert.equal(W.parseStatus("[1,2]"), null)
assert.deepEqual(W.parseStatus('{"schema":1}'), { schema: 1 })

assert.equal(W.formatDuration(0), "0m")
assert.equal(W.formatDuration(65_000), "1m")
assert.equal(W.formatDuration(HOUR + 5 * 60_000), "1h 05m")
assert.equal(W.formatClock(HOUR + 5 * 60_000), "1:05")
assert.equal(W.formatClock(9 * 60_000), "9m")

// The bar never shows a measure sum: 2h attested + 1h inferred + 4h agent is not 7h.
assert.equal(W.barLabel(status), "2:00")
assert.equal(W.barLabel(null), "--")
const agentOnly = { ...status, measures: { ...status.measures, attested: { union_ms: 0 }, inferred: { union_ms: 0 } } }
assert.equal(W.barLabel(agentOnly), "0m")

assert.equal(W.staleness(status, NOW, 30), "fresh")
assert.equal(W.staleness(status, NOW + 3 * 60_000, 30), "stale")
assert.equal(W.staleness(null, NOW, 30), "missing")
assert.equal(W.isOffline(null, NOW, 30), true)
assert.equal(W.isOffline(status, NOW, 30), false)

// Values cross the vm realm boundary, so compare copies.
assert.deepEqual([...W.warnings(status)], ["Unallocated evidence: 5m"])
assert.match(W.warnings(null)[0], /No status yet/)
const conflicted = { ...status, coverage: { ...status.coverage, conflicts: 2, open_agent_turns: 1, open_sessions: 1 } }
assert.deepEqual([...W.warnings(conflicted)], [
  "2 conflicting redeliveries need review",
  "1 agent turn(s) with no end",
  "A session is open: its time is provisional",
  "Unallocated evidence: 5m"
])

const rows = W.displayRows(status)
assert.deepEqual([...rows.map(r => r.label)], ["Attested session", "Inferred attended", "Agent runtime"])
assert.deepEqual([...rows.map(r => r.value)], ["2h 00m", "1h 00m", "4h 00m"])
assert.deepEqual([...rows[1].projects], ["coral 50m", "other 5m", "unallocated 5m"])
assert.deepEqual([...rows[0].projects], ["coral 2h 00m"])
assert.deepEqual([...W.displayRows(null).map(r => r.value)], ["0m", "0m", "0m"])

assert.equal(W.sessionLine(status), "No session running")
assert.equal(W.sessionLine({ ...status, current_session: { project: null, provisional_ms: 90_000 } }), "unallocated - 2m provisional")
assert.match(W.tooltip(null, NOW, 30), /no status file/)
assert.match(W.tooltip({ ...status, generated_at: NOW - 10 * 60_000 }, NOW, 30), /daemon not writing/)
assert.match(W.tooltip(status, NOW, 30), /never added together/)
assert.match(W.NON_ADDITIVE, /never added together/)
assert.equal(W.shortMessage("error: nope\nmore"), "error: nope")
assert.equal(W.shortMessage("x".repeat(300)).length, 163)

console.log("Workspan widget helpers passed")
