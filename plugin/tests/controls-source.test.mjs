import assert from "node:assert/strict"
import fs from "node:fs"
import vm from "node:vm"
import test from "node:test"

const panel = fs.readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
function helper(name) {
  const match = panel.match(new RegExp("  function " + name + "\\([^)]*\\) \\{\\n([\\s\\S]*?)\\n  \\}"))
  assert.ok(match, name)
  return match[1]
}

test("plain Stop never consumes an activity draft", () => {
  let sent
  const root = { activity: "reviewed auth", sessionOpen: true, snapshot: {current_session: {session: "session-a"}}, runCli: args => { sent = args } }
  vm.runInNewContext(helper("stopSession"), { root })
  assert.equal(root.activity, "reviewed auth")
  assert.deepEqual(Array.from(sent), ["session", "stop", "--session", "session-a"])
})
