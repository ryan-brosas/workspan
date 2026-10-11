.pragma library

// Pure argv and draft-settlement decisions for the manual activity field. No QML
// types and no I/O, so tests/draft.test.mjs runs this file directly with node
// --test. The daemon's note is the ledger's only free text; these decisions keep
// the widget's drafts honest about which session they belong to.

/** The draft belongs to the session it was first typed in: a later switch or
 *  stop must never silently move it to another one. */
function draftSessionFor(text, draftSession, session) {
  // Whitespace is not a draft (hasDraft trims too), so it pins no session: the
  // first real keystroke decides whose session the draft belongs to.
  var value = String(text == null ? "" : text).trim()
  if (value === "") return ""
  if (draftSession === "") return session
  return draftSession
}

/** The argv that saves the draft, or null when there is nothing to save. The
 *  session is named explicitly, so the note lands where it was typed even if
 *  the session has since stopped or switched, and the words travel after "--":
 *  a note like "--idle" or "--session" is the person's text, never an option. */
function noteArgv(text, draftSession) {
  var value = String(text == null ? "" : text).trim()
  if (value === "" || draftSession === "") return null
  return ["note", "--session", draftSession, "--", value]
}

/** Whether clocking out files the draft: the one predicate for "this draft
 *  belongs to the session being stopped", read by both the argv and the QML. */
function clockOutConsumesDraft(text, draftSession, session) {
  if (session === "") return false
  return String(text == null ? "" : text).trim() !== "" && draftSession === session
}

/** The argv that clocks out, or null when the draft blocks it: a draft from
 *  another session never rides along with this one's stop. The closing-note
 *  decision comes from clockOutConsumesDraft, so the argv and the QML's
 *  consumesDraft flag can never disagree about the same draft. The note travels
 *  after "--", exactly like Save note's, so a note of "--idle" is the person's
 *  text and never an option. */
function clockOutArgv(text, draftSession, session) {
  if (session === "") return null
  var value = String(text == null ? "" : text).trim()
  if (value !== "" && !clockOutConsumesDraft(text, draftSession, session)) return null
  var argv = ["session", "stop", "--session", session]
  if (value !== "") argv = argv.concat(["--", value])
  return argv
}

/** The plain stop: it never carries a note. */
function stopArgv(session) {
  return session === "" ? null : ["session", "stop", "--session", session]
}

/** What the draft text becomes when a command finishes: cleared only when the
 *  daemon accepted the exact draft that was submitted. A failure, a different
 *  draft edited meanwhile, or a draft that moved to another session keeps it. */
function activityAfterCompletion(activity, draftSession, submitted, success) {
  if (!success || !submitted) return activity
  if (activity === submitted.text && draftSession === submitted.session) return ""
  return activity
}
