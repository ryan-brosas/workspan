import QtQuick
import qs.Commons
import qs.Ui
import "Draft.js" as Draft

// The popup's whole action surface: the session buttons that were always there,
// plus the manual activity draft with its own clock actions. Ephemeral UI state
// only - every command goes through the CLI to the daemon, and every argv
// decision about the draft lives in Draft.js, which node --test executes
// directly (tests/draft.test.mjs). Nothing here touches the database.
FocusScope {
  id: root
  property string session: ""
  property bool paused: false
  property string project: ""
  property bool busy: false
  property color foreground: Color.foreground
  property string fontFamily: Style.font.family
  // Returns false if the host cannot dispatch. Never treat a refusal as a save.
  property var dispatch: function(args) { return false }
  property string activity: ""
  property string draftSession: ""
  property var pendingDraft: null
  /** Set before dispatch and cleared by completeCommand, so an in-flight command
   *  blocks a second one even before the host reports busy. */
  property bool inFlight: false
  readonly property bool hasDraft: activity.trim() !== ""
  readonly property bool staleDraft: hasDraft && draftSession !== session
  readonly property bool available: !busy && !inFlight
  signal refreshRequested()
  signal escapeRequested()

  implicitHeight: content.implicitHeight
  onActivityChanged: {
    // Typing breaks the field's text binding, so the sync back to the field is
    // explicit: clearing a draft after success must always empty the editor.
    if (activityField.text !== activity) activityField.text = activity
    draftSession = Draft.draftSessionFor(activity, draftSession, session)
  }

  function submit(args, consumesDraft) {
    if (!available) return false
    var pending = consumesDraft ? { text: activity, session: draftSession } : null
    // Mark in flight before dispatch: a synchronous completion must still clear
    // the submitted draft instead of leaving a snapshot no exit will ever settle.
    inFlight = true
    pendingDraft = pending
    var accepted = false
    try { accepted = dispatch(args) } catch (_) { accepted = false }
    if (!accepted) {
      inFlight = false
      pendingDraft = null
      return false
    }
    return true
  }

  // The host calls this when the CLI exits. Failures keep the draft; a success
  // clears only the exact draft that was submitted.
  function completeCommand(success) {
    if (!inFlight) return
    inFlight = false
    var submitted = pendingDraft
    pendingDraft = null
    var settled = Draft.activityAfterCompletion(activity, draftSession, submitted, success)
    if (settled !== activity) activity = settled
  }

  function startSession() {
    return submit(project === "" ? ["session", "start"] : ["session", "start", "--project", project], false)
  }

  // Plain stop: no note, ever. The draft stays for the person to save or discard.
  function stopSession() {
    var argv = Draft.stopArgv(session)
    return argv === null ? false : submit(argv, false)
  }

  function clockOut() {
    var argv = Draft.clockOutArgv(activity, draftSession, session)
    return argv === null ? false : submit(argv, Draft.clockOutConsumesDraft(activity, draftSession, session))
  }

  function saveNote() {
    // Enter and the Save note button share this guard: an empty or unsessioned
    // draft never dispatches, so the two entry points cannot disagree.
    if (!hasDraft || draftSession === "") return false
    var argv = Draft.noteArgv(activity, draftSession)
    return argv === null ? false : submit(argv, true)
  }

  Keys.onEscapePressed: function(event) { escapeRequested(); event.accepted = true }

  Column {
    id: content
    width: parent.width
    spacing: Style.space(8)

    // The original session controls: the same actions as before, in a wrapping
    // row so they never clip at the popup's width.
    Flow {
      objectName: "sessionActions"
      width: parent.width
      spacing: Style.space(8)

      Button {
        objectName: "startSession"
        visible: root.session === ""
        text: "Start session"
        bordered: true
        focusable: true
        foreground: root.foreground
        fontFamily: root.fontFamily
        enabled: root.available
        onClicked: root.startSession()
      }

      Button {
        objectName: "pauseResume"
        visible: root.session !== ""
        text: root.paused ? "Resume" : "Pause"
        bordered: true
        focusable: true
        foreground: root.foreground
        fontFamily: root.fontFamily
        enabled: root.available
        onClicked: root.submit(["session", root.paused ? "resume" : "pause", "--session", root.session], false)
      }

      Button {
        objectName: "plainStop"
        visible: root.session !== ""
        text: "Stop"
        bordered: true
        focusable: true
        foreground: root.foreground
        fontFamily: root.fontFamily
        enabled: root.available
        onClicked: root.stopSession()
      }

      Button {
        objectName: "refresh"
        text: "Refresh"
        bordered: true
        focusable: true
        foreground: root.foreground
        fontFamily: root.fontFamily
        onClicked: root.refreshRequested()
      }
    }

    Text {
      width: parent.width
      text: "Manual activity - optional, one line, at most " + activityField.maximumLength + " characters"
      textFormat: Text.PlainText
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }

    TextField {
      id: activityField
      objectName: "activityField"
      width: parent.width
      placeholderText: "What were you doing?"
      foreground: root.foreground
      font.family: root.fontFamily
      maximumLength: 200
      // The field only carries a session's note: idle with no draft, there is
      // nothing yet to attach the words to.
      enabled: root.available && (root.session !== "" || root.hasDraft)
      onTextEdited: root.activity = text
      // Enter only saves a note. Clocking in and out always needs its own button.
      onAccepted: root.saveNote()
    }

    Text {
      objectName: "draftWarning"
      width: parent.width
      visible: root.staleDraft
      text: "This draft belongs to a previous session. Save note still files it there; clocking this session out needs it saved or discarded first."
      textFormat: Text.PlainText
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }

    // The manual clock actions, separate from the session row above: clocking
    // in and out is an addition, never a replacement of it.
    Flow {
      objectName: "manualActions"
      width: parent.width
      spacing: Style.space(8)

      Button {
        objectName: "clockAction"
        text: root.session !== "" ? "Clock out" : "Clock in"
        bordered: true
        focusable: true
        foreground: root.foreground
        fontFamily: root.fontFamily
        enabled: root.available && (root.session === "" || !root.staleDraft)
        onClicked: root.session !== "" ? root.clockOut() : root.startSession()
      }

      Button {
        objectName: "saveNote"
        text: "Save note"
        bordered: true
        focusable: true
        foreground: root.foreground
        fontFamily: root.fontFamily
        enabled: root.available && root.hasDraft && root.draftSession !== ""
        onClicked: root.saveNote()
      }

      Button {
        // Save note and Discard draft gate the same way: present but disabled
        // without a draft, so the row does not change shape as a draft appears.
        objectName: "discardDraft"
        text: "Discard draft"
        bordered: true
        focusable: true
        foreground: root.foreground
        fontFamily: root.fontFamily
        enabled: root.available && root.hasDraft
        onClicked: root.activity = ""
      }
    }
  }
}
