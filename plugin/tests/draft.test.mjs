import assert from "node:assert/strict"
import fs from "node:fs"
import vm from "node:vm"
import test from "node:test"

// Draft.js is a QML library; here it is evaluated with an explicit export list so
// the same source is testable without QML.
const source = fs.readFileSync(new URL("../Draft.js", import.meta.url), "utf8").replace(/^\.pragma library\s*/, "")
// A fresh vm context already provides the standard intrinsics, so the sandbox
// only needs the export target: injecting host constructors would make any
// instanceof check inside Draft.js compare against the wrong realm.
const sandbox = { module: { exports: {} } }
vm.runInNewContext(source + "\nmodule.exports = { draftSessionFor, noteArgv, clockOutArgv, clockOutConsumesDraft, stopArgv, activityAfterCompletion }", sandbox, { filename: "Draft.js" })
const D = sandbox.module.exports
// argv arrays come from the vm realm; copy them so structural equality is not
// tripped by the different Array prototypes of two realms.
const argv = (value) => value === null ? null : Array.from(value)

test("a draft belongs to the session it was first typed in", () => {
  assert.equal(D.draftSessionFor("", "s1", "s2"), "", "a cleared draft releases its session")
  assert.equal(D.draftSessionFor("   ", "s1", "s2"), "", "whitespace is no draft, so it pins no session")
  assert.equal(D.draftSessionFor("work", "", "s1"), "s1", "the first keystroke pins the running session")
  assert.equal(D.draftSessionFor("more", "s1", "s2"), "s1", "a switch never steals the draft")
})

test("Save note names its session explicitly", () => {
  assert.deepEqual(argv(D.noteArgv("  wrap up  ", "s1")), ["note", "--session", "s1", "--", "wrap up"])
  for (const text of ["--session", "--socket", "--idle", "--"]) {
    assert.deepEqual(argv(D.noteArgv(text, "s1")), ["note", "--session", "s1", "--", text])
  }
  assert.equal(D.noteArgv("   ", "s1"), null, "whitespace is no note")
  assert.equal(D.noteArgv("text", ""), null, "a draft with no session cannot be filed")
})

test("Clock out carries only the draft that belongs to the current session", () => {
  assert.deepEqual(argv(D.clockOutArgv("auth work", "s1", "s1")), ["session", "stop", "--session", "s1", "--note", "auth work"])
  assert.deepEqual(argv(D.clockOutArgv("", "s1", "s1")), ["session", "stop", "--session", "s1"])
  assert.equal(D.clockOutArgv("old work", "s1", "s2"), null, "a stale draft blocks the ride-along")
  assert.equal(D.clockOutArgv("work", "s1", ""), null, "no session to clock out")
})

test("Clock out carries a flag-like or padded note verbatim", () => {
  assert.deepEqual(argv(D.clockOutArgv("--socket", "s1", "s1")), ["session", "stop", "--session", "s1", "--note", "--socket"])
  assert.deepEqual(argv(D.clockOutArgv("  auth work  ", "s1", "s1")), ["session", "stop", "--session", "s1", "--note", "auth work"])
  assert.equal(D.clockOutConsumesDraft("--socket", "s1", "s1"), true, "a real draft rides with its own session")
  assert.equal(D.clockOutConsumesDraft("", "s1", "s1"), false, "no draft, no note")
  assert.equal(D.clockOutConsumesDraft("work", "s1", "s2"), false, "a stale draft does not ride along")
})

test("the plain stop never carries a note", () => {
  assert.deepEqual(argv(D.stopArgv("s1")), ["session", "stop", "--session", "s1"])
  assert.equal(D.stopArgv(""), null)
})

test("a draft clears only after its own command is accepted", () => {
  const submitted = { text: "auth work", session: "s1" }
  assert.equal(D.activityAfterCompletion("auth work", "s1", submitted, true), "")
  assert.equal(D.activityAfterCompletion("auth work", "s1", submitted, false), "auth work", "a failure keeps the draft")
  assert.equal(D.activityAfterCompletion("auth work", "s1", null, true), "auth work", "nothing was submitted for this command")
  assert.equal(D.activityAfterCompletion("edited meanwhile", "s1", submitted, true), "edited meanwhile", "the draft changed while the command ran")
  assert.equal(D.activityAfterCompletion("auth work", "s2", submitted, true), "auth work", "the draft moved to another session while the command ran")
})
