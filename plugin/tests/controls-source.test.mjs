import assert from "node:assert/strict"
import fs from "node:fs"
import vm from "node:vm"
import test from "node:test"

const panel = fs.readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
const controls = fs.readFileSync(new URL("../SessionControls.qml", import.meta.url), "utf8")
const draftSource = fs.readFileSync(new URL("../Draft.js", import.meta.url), "utf8").replace(/^\.pragma library\s*/, "")

// Panel.qml is QML, so the handler under test is extracted from source rather
// than imported. The signature match tolerates spacing; only the two-space
// closing brace stays fixed, because the body is what the test needs.
function helper(name) {
  const match = panel.match(new RegExp("^  function " + name + "\\s*\\([^)]*\\)\\s*\\{\\n([\\s\\S]*?)\\n  \\}", "m"))
  assert.ok(match, "function " + name + " not found in Panel.qml - update the extraction regex")
  return match[1]
}

test("plain Stop never consumes an activity draft", () => {
  let sent
  const root = { activity: "reviewed auth", currentSessionId: "session-a", runCli: args => { sent = args } }
  // Compile the body as a function: an early return in the QML handler must
  // behave like a return, not throw an illegal top-level return.
  vm.runInNewContext("(function () {\n" + helper("stopSession") + "\n})()", { root })
  assert.equal(root.activity, "reviewed auth")
  assert.ok(Array.isArray(sent), "stopSession did not dispatch a stop command")
  assert.deepEqual(Array.from(sent), ["session", "stop", "--session", "session-a"])
})

test("runCli refuses a busy process visibly without replacing its command", () => {
  const root = { busy: true, lastError: "" }
  const cliProcess = { running: true, command: ["existing"] }
  const run = vm.runInNewContext("(function(args) {" + helper("runCli") + "})", { root, cliProcess })
  assert.equal(run(["session", "stop"]), false)
  assert.equal(root.lastError, "A command is already in progress")
  assert.deepEqual(cliProcess.command, ["existing"])
})

// SessionControls.submit/completeCommand are exercised from the real source with
// the real Draft.js, the way the critic's probe did. This is not rendered-QML
// proof, but it is the shipped bodies, not a reimplementation.
function controlsBody(name) {
  const match = controls.match(new RegExp("^  function " + name + "\\s*\\([^)]*\\)\\s*\\{\\n([\\s\\S]*?)\\n  \\}", "m"))
  assert.ok(match, "function " + name + " not found in SessionControls.qml - update the extraction regex")
  return match[1]
}

const Draft = vm.runInNewContext(draftSource + "\n({ activityAfterCompletion })")

function makeControls(dispatch) {
  const c = { activity: "  work  ", draftSession: "s1", pendingDraft: null, inFlight: false, busy: false, Draft }
  Object.defineProperty(c, "available", { get() { return !c.busy && !c.inFlight } })
  c.dispatch = args => dispatch(c, args)
  for (const [name, params] of [["submit", "args,consumesDraft"], ["completeCommand", "success"]]) {
    c[name] = vm.runInNewContext("(function(" + params + "){" + controlsBody(name) + "})", c)
  }
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
  assert.equal(c.available, true)
})

test("submit/completeCommand: a failed command keeps the submitted draft", () => {
  const c = makeControls(() => true)
  c.submit(["note"], true)
  c.completeCommand(false)
  assert.equal(c.activity, "  work  ")
  assert.equal(c.inFlight, false)
})
