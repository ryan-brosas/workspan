import assert from "node:assert/strict"
import fs from "node:fs"
import vm from "node:vm"
import test from "node:test"

const normalizeSource = source => source.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n")
const readSource = path => normalizeSource(fs.readFileSync(new URL(path, import.meta.url), "utf8"))
const panel = readSource("../Panel.qml")
const controls = readSource("../SessionControls.qml")
const draftSource = readSource("../Draft.js").replace(/^\s*\.pragma\s+library[^\n]*\n?/m, "")

// Execute shipped handler bodies, not a reimplementation. This is not rendered
// QML proof: the two-space closing brace remains part of the extraction contract.
function extractFunction(source, label, name) {
  const match = source.match(new RegExp("^  function " + name + "\\s*\\(([^)]*)\\)\\s*\\{\\n([\\s\\S]*?)\\n  \\}", "m"))
  assert.ok(match, "function " + name + " not found in " + label + " - update the extraction regex")
  // The trailing newline keeps a body-ending // comment from swallowing the brace
  // the wrapper appends; capturing the signature keeps the wrapper in sync with it.
  return { params: match[1], body: match[2] + "\n" }
}
const helper = name => extractFunction(panel, "Panel.qml", name)
const controlsBody = name => extractFunction(controls, "SessionControls.qml", name)
const invoke = (fn, context) => vm.runInNewContext("(function(" + fn.params + "){" + fn.body + "})", context)

test("plain Stop never consumes an activity draft", () => {
  let sent
  const root = { activity: "reviewed auth", currentSessionId: "session-a", runCli: args => { sent = args } }
  invoke(helper("stopSession"), { root })()
  assert.equal(root.activity, "reviewed auth")
  assert.ok(Array.isArray(sent), "stopSession did not dispatch a stop command")
  assert.deepEqual(Array.from(sent), ["session", "stop", "--session", "session-a"])
})

test("runCli refuses a busy process visibly without replacing its command", () => {
  const root = { busy: true, lastError: "" }
  const cliProcess = { running: true, command: ["existing"] }
  const run = invoke(helper("runCli"), { root, cliProcess })
  assert.equal(run(["session", "stop"]), false)
  assert.equal(root.lastError, "A command is already in progress")
  assert.deepEqual(cliProcess.command, ["existing"])
})

const Draft = vm.runInNewContext(draftSource + "\n({ activityAfterCompletion })")
function makeControls(dispatch) {
  const c = { activity: "  work  ", draftSession: "s1", pendingDraft: null, inFlight: false, busy: false, Draft }
  Object.defineProperty(c, "available", { get() { return !c.busy && !c.inFlight } })
  c.dispatch = args => dispatch(c, args)
  for (const name of ["submit", "completeCommand"]) c[name] = invoke(controlsBody(name), c)
  return c
}

test("submit/completeCommand: a synchronous success clears only the submitted draft", () => {
  const c = makeControls(self => { self.completeCommand(true); return true })
  assert.equal(c.submit(["note"], true), true)
  assert.equal(c.activity, "")
  assert.equal(c.inFlight, false)
  assert.equal(c.pendingDraft, null)
})

test("submit/completeCommand: a refused dispatch rolls back and keeps the draft", () => {
  const c = makeControls(() => false)
  assert.equal(c.submit(["note"], true), false)
  assert.equal(c.activity, "  work  ")
  assert.equal(c.inFlight, false)
  assert.equal(c.pendingDraft, null)
})

test("submit/completeCommand: a command is single-flight, and a non-draft one never clears the draft", () => {
  let calls = 0
  const c = makeControls(() => { calls++; return true })
  assert.equal(c.submit(["pause"], false), true)
  assert.equal(c.submit(["note"], true), false, "a second command is refused while the first is in flight")
  assert.equal(calls, 1)
  c.completeCommand(true)
  assert.equal(c.activity, "  work  ", "a non-draft command leaves the draft alone")
  assert.equal(c.inFlight, false)
})

test("submit/completeCommand: a failed command keeps the submitted draft", () => {
  const c = makeControls(() => true)
  c.submit(["note"], true)
  assert.deepEqual(JSON.parse(JSON.stringify(c.pendingDraft)), { text: "  work  ", session: "s1" })
  c.completeCommand(false)
  assert.equal(c.pendingDraft, null)
  assert.equal(c.activity, "  work  ")
  assert.equal(c.inFlight, false)
})

test("source extraction normalizes CRLF and BOM", () => {
  const windows = "\uFEFF" + panel.replace(/\n/g, "\r\n")
  assert.deepEqual(extractFunction(normalizeSource(windows), "Panel.qml", "runCli"), helper("runCli"))
})

test("submit rolls back a throwing dispatcher and permits a retry", () => {
  let calls = 0
  const c = makeControls(() => { if (++calls === 1) throw new Error("launch failure"); return true })
  assert.equal(c.submit(["note"], true), false)
  assert.equal(c.inFlight, false)
  assert.equal(c.pendingDraft, null)
  assert.equal(c.activity, "  work  ")
  assert.equal(c.submit(["note"], true), true)
  c.completeCommand(true)
  assert.equal(c.activity, "")
})

test("host settlement is inert without a controls command", () => {
  const c = makeControls(() => true)
  c.completeCommand(true)
  assert.equal(c.activity, "  work  ")
  assert.equal(c.pendingDraft, null)
  assert.equal(c.inFlight, false)
})

test("finishCli ignores a second completion of the same command", () => {
  let completions = 0
  let refreshes = 0
  const root = { busy: true, lastError: "", pendingClose: false, refreshNow: () => refreshes++ }
  const controlsStub = { completeCommand: () => completions++ }
  const finish = invoke(helper("finishCli"), { root, controls: controlsStub })
  finish(127, "launch failed")
  finish(0, "")
  assert.equal(root.busy, false)
  assert.equal(root.lastError, "launch failed")
  assert.equal(completions, 1)
  assert.equal(refreshes, 1)
})

test("finishCli keeps a refusal notice when the in-flight command succeeds", () => {
  const root = { busy: true, lastError: "A command is already in progress", pendingClose: false, refreshNow: () => {} }
  const finish = invoke(helper("finishCli"), { root, controls: { completeCommand: () => {} } })
  finish(0, "")
  assert.equal(root.lastError, "A command is already in progress")
})

test("a pick defers its close to a successful settle", () => {
  const root = { sessionOpen: true, pendingClose: false, runCli: () => true }
  const pick = invoke(helper("projectClicked"), { root })
  assert.equal(pick("project"), true)
  assert.equal(root.pendingClose, true)
})

test("a refused project dispatch reports false so the popup stays open", () => {
  const root = { sessionOpen: true, runCli: () => false }
  const pick = invoke(helper("projectClicked"), { root })
  assert.equal(pick("project"), false)
})
