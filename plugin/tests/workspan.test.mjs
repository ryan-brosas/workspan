import assert from "node:assert/strict"
import fs from "node:fs"
import vm from "node:vm"

// The widget imports Workspan.js as a QML library; here it is evaluated with an
// explicit export list so the same source is testable without QML.
const source = fs.readFileSync(new URL("../Workspan.js", import.meta.url), "utf8")
  .replace(/^\.pragma library\s*/, "")
  + "\nmodule.exports = { NON_ADDITIVE, expandPath, parseStatus, measure, formatDuration, formatClock, verticalClock, barLabel, barLabelVertical, ageSeconds, staleness, isOffline, displayRows, measureCaveats, companyRows, dotHint, idleHint, uncoveredHint, warnings, sessionLine, tooltip, shortMessage, engineLine }\n"
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

// An open session takes the bar: the user wants to see the clock they started.
const running = { ...status, current_session: { project: "coral", provisional_ms: 3_600_000 + 5 * 60_000, state: "running" } }
assert.equal(W.barLabel(running), "1:05")
const pausedOpen = { ...status, current_session: { project: "coral", provisional_ms: 90_000, state: "paused", paused_at: 90_000 } }
assert.equal(W.barLabel(pausedOpen), "2m")

// The vertical bar stacks the timer the way the stock clock stacks its lines.
assert.equal(W.verticalClock(65 * 60_000), "1h\n05m")
assert.equal(W.verticalClock(125 * 60_000), "2h\n05m")
assert.equal(W.verticalClock(90_000), "2m")
assert.equal(W.verticalClock(0), "0m")
assert.equal(W.barLabelVertical(running), "1h\n05m")
assert.equal(W.barLabelVertical({ ...status, current_session: null }), "2h\n00m")
assert.equal(W.barLabelVertical(pausedOpen), "2m")
assert.equal(W.barLabelVertical(null), "--")

// The popup company picker marks the active project and drops duplicates.
const withCoralStuff = { ...status, current_session: { project: "coral-stuff", provisional_ms: 90_000, state: "running" } }
assert.deepEqual([...W.companyRows([{ project: "coral-stuff", root: "/a" }, { project: "workspan", root: "/b" }, { project: "coral-stuff", root: "/c" }], withCoralStuff).map(r => ({ project: String(r.project), active: r.active === true }))],
  [{ project: "coral-stuff", active: true }, { project: "workspan", active: false }])
assert.deepEqual([...W.companyRows("not an array", null)], [])
assert.deepEqual([...W.companyRows([], { ...status, current_session: { project: "workspan" } })], [])
assert.deepEqual([...W.companyRows([{ project: "workspan", root: "/b" }], running).map(r => ({ project: String(r.project), active: r.active === true }))],
  [{ project: "workspan", active: false }])

// The Dot nudge: presence only. Fresh and untracked shows; everything else hides.
const dotPresence = { available: true, last_activity_at: NOW - 4 * 60_000 }
assert.equal(W.dotHint(dotPresence, status, NOW), "Dot active 4m ago \u2014 not tracked")
assert.equal(W.dotHint(dotPresence, running, NOW), "")
assert.equal(W.dotHint({ available: true, last_activity_at: NOW - 30_000 }, status, NOW), "Dot active just now \u2014 not tracked")
assert.equal(W.dotHint({ available: true, last_activity_at: NOW - 20 * 60_000 }, status, NOW), "")
assert.equal(W.dotHint({ available: false, last_activity_at: NOW - 60_000 }, status, NOW), "")
assert.equal(W.dotHint({ available: true }, status, NOW), "")
assert.equal(W.dotHint(null, status, NOW), "")
// The return-from-idle nudge: annotation only. It shows while the seat is quiet or
// shortly after, and it never claims anything was adjusted.
const idleStatus = { ...status, last_idle: { from: NOW - 30 * 60_000, to: NOW - 6 * 60_000, idle_ms: 24 * 60_000, still_away: false } }
assert.equal(W.idleHint(idleStatus, NOW), "No input for 24m \u2014 nothing was paused automatically")
// An open stretch is not asserted: "away" and "the collector stopped" look identical.
assert.equal(W.idleHint({ ...status, last_idle: { from: NOW - 30 * 60_000, to: null, idle_ms: 30 * 60_000, still_away: true } }, NOW), "")
assert.equal(W.idleHint({ ...idleStatus, last_idle: { ...idleStatus.last_idle, to: NOW - 40 * 60_000 } }, NOW), "")
assert.equal(W.idleHint({ ...status, last_idle: { from: NOW - 30 * 60_000, to: NOW - 30 * 60_000 + 3_000, idle_ms: 3_000, still_away: false } }, NOW), "")
assert.equal(W.idleHint({ ...status, last_idle: { from: NOW, to: NOW - 60_000 } }, NOW), "")
assert.equal(W.idleHint(status, NOW), "")
assert.equal(W.idleHint(null, NOW), "")

// The uncovered review list: only a real stretch of the day, and only when long enough.
assert.equal(W.uncoveredHint({ ...status, uncovered: { today_ms: 2 * HOUR + 25 * 60_000, stretches: [] } }), "2h 25m today has no evidence \u2014 attest it in workspan day")
assert.equal(W.uncoveredHint({ ...status, uncovered: { today_ms: 10 * 60_000, stretches: [] } }), "")
assert.equal(W.uncoveredHint({ ...status, uncovered: { today_ms: 0, stretches: [] } }), "")
assert.equal(W.uncoveredHint(status), "")
assert.equal(W.uncoveredHint(null), "")

assert.match(W.tooltip(running, NOW, 30), /coral - 1h 05m provisional \(running\)/)
assert.match(W.tooltip(pausedOpen, NOW, 30), /coral - 2m provisional \(paused\)/)

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
// Values cross the vm realm boundary, so rebuild them in this realm before comparing.
assert.deepEqual(rows[1].projects.map(p => ({ project: p.project, ms: p.ms })), [{ project: "coral", ms: 3_000_000 }, { project: "other", ms: 300_000 }])
assert.deepEqual([...rows[1].caveats], ["unallocated 5m"])
assert.deepEqual(rows[0].projects.map(p => ({ project: p.project, ms: p.ms })), [{ project: "coral", ms: 7_200_000 }])
assert.deepEqual([...rows[0].caveats], [])
assert.deepEqual([...W.displayRows(null).map(r => r.value)], ["0m", "0m", "0m"])
assert.deepEqual([...W.displayRows(null)[0].projects], [])

assert.equal(W.sessionLine(status), "No session running")
assert.equal(W.sessionLine({ ...status, current_session: { project: null, provisional_ms: 90_000, state: "running" } }), "unallocated - 2m provisional")
assert.equal(W.sessionLine({ ...status, current_session: { project: "coral", provisional_ms: 90_000, state: "paused" } }), "coral - 2m provisional (paused)")
assert.match(W.tooltip(null, NOW, 30), /no status file/)
assert.match(W.tooltip({ ...status, generated_at: NOW - 10 * 60_000 }, NOW, 30), /daemon not writing/)
// The bar shortcut is advertised where a person looks for it.
assert.match(W.tooltip(running, NOW, 30), /middle-click to clock in\/out/)

// Clocking in and out is the popup primary action: the labels exist, and the row
// comes before the advisory text and the company picker that used to push it below
// the fold of a scrolling popup.
const panel = fs.readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
const controls = fs.readFileSync(new URL("../SessionControls.qml", import.meta.url), "utf8")
// The controls are the whole action surface and stay above everything
// advisory: the session buttons that were always there, plus the draft.
const controlsAt = panel.search(/^\s*SessionControls\s*\{/m)
assert.ok(controlsAt !== -1, "the panel must instantiate the controls")
assert.ok(controlsAt < panel.indexOf("root.idleHint"), "the controls must precede the idle nudge")
// The picker block, not the property assignment far above it in the Process handler.
assert.ok(controlsAt < panel.indexOf("root.companies.length > 0"), "the controls must precede the company picker")
assert.ok(controlsAt < panel.indexOf("Workspan.displayRows(root.snapshot)"), "the controls must precede the measures")
assert.match(panel, /onClicked: root\.projectClicked\(companyRow\.modelData\.project\)/)
assert.match(panel, /if \(code === 0 && root\.pendingClose\) root\.close\(\)/)
// Wiring: a dispatch refusal is not a save, a draft clears only when the daemon
// accepted the command that carried it, and the panel's shortcuts stand down
// while the controls own keys.
assert.match(panel, /blocked: controls\.activeFocus/)
assert.match(panel, /controls\.completeCommand\(code === 0\)/)
assert.match(panel, /if \(cliProcess\.running\) \{/)
// The launch-failure settlement is real wiring in Panel.qml, not only in the
// offscreen probe: a missing CLI must be told from an ordinary exit.
assert.match(panel, /function finishCli\(/)
assert.match(panel, /onStarted: cliProcess\.launchStarted = true/)
// The launch reset and guard must actually live in cliProcess.onRunningChanged,
// not merely appear somewhere in the file.
const ocAt = panel.indexOf("if (running) { cliProcess.launchStarted = false; return }")
assert.ok(ocAt !== -1, "the launch reset must live in cliProcess.onRunningChanged")
const ocBlock = panel.slice(ocAt, ocAt + 260)
assert.match(ocBlock, /if \(cliProcess\.launchStarted \|\| !root\.busy\) return/)
assert.match(ocBlock, /finishCli\(127/)
// The controls receive the live session/pause state from the panel: without the
// bindings their labels would silently stay "Clock in"/"Pause".
const controlsBlock = panel.slice(controlsAt, controlsAt + 400)
assert.match(controlsBlock, /session: root\.currentSessionId/)
assert.match(controlsBlock, /paused: root\.sessionPaused/)
// Manual clocking stays an addition: every original session button is still
// there, and every argv decision about the draft lives in Draft.js, whose laws
// draft.test.mjs executes.
assert.match(controls, /text: "Start session"/)
assert.match(controls, /text: root\.paused \? "Resume" : "Pause"/)
assert.match(controls, /text: "Stop"/)
assert.match(controls, /text: root\.session !== "" \? "Clock out" : "Clock in"/)
assert.match(controls, /text: "Save note"/)
assert.match(controls, /text: "Discard draft"/)
assert.match(controls, /maximumLength: 200/)
assert.match(controls, /placeholderText: "What were you doing\?"/)
// blocked: controls.activeFocus is only correct while SessionControls is a
// FocusScope, so pin that dependency instead of letting a refactor break it.
assert.match(controls, /^FocusScope\s*\{/m)
assert.match(controls, /Draft\.noteArgv/)
assert.match(controls, /Draft\.clockOutArgv/)
assert.match(controls, /Draft\.stopArgv/)
assert.match(W.tooltip(status, NOW, 30), /never added together/)
assert.match(W.NON_ADDITIVE, /never added together/)

// The popup says which engine did the arithmetic.
assert.equal(W.engineLine(status), "")
const withEngine = { ...status, engine: { label: "generated Bend policy", native: false, version: "2.0.31", digest: "144316b726023c9e320fce225345680441fb2dbc0ea1cc623c111b129ca524a9" } }
assert.equal(W.engineLine(withEngine), "Bend 2.0.31 - generated policy - 144316b7 - gap 15m")
assert.equal(W.engineLine({ ...withEngine, engine: { ...withEngine.engine, native: true } }), "Bend 2.0.31 - native lane - 144316b7 - gap 15m")
assert.equal(W.engineLine({ ...status, engine: { label: "native Bend", native: true } }), "native lane - gap 15m")
assert.equal(W.shortMessage("error: nope\nmore"), "error: nope")
assert.equal(W.shortMessage("x".repeat(300)).length, 163)

console.log("Workspan widget helpers passed")
