import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Workspan.js" as Workspan

// Workspan bar widget: a display for the local daemon, never a second writer.
//
// It reads one file ($XDG_RUNTIME_DIR/workspan/status.json, written by the daemon
// with an atomic rename) and it runs one CLI. It never opens the database, holds
// no durable state of its own, and shows "not writing" rather than inventing a
// number when the daemon stops.
Panel {
  id: root
  moduleName: "workspan.tracker"
  manageIpc: false

  // ------------------------------------------------------------- settings
  readonly property string home: Quickshell.env("HOME") || ""
  readonly property string runtimeDir: Quickshell.env("WORKSPAN_RUNTIME_DIR")
    || ((Quickshell.env("XDG_RUNTIME_DIR") || "/tmp") + "/workspan")
  readonly property string statusFile: Workspan.expandPath(setting("statusFile", ""), runtimeDir + "/status.json", home)
  readonly property string socketFile: Workspan.expandPath(setting("socketPath", ""), runtimeDir + "/workspan.sock", home)
  readonly property string cliPath: String(setting("cliPath", "workspan"))
  readonly property string project: String(setting("project", ""))
  readonly property int refreshSeconds: Math.max(5, Number(setting("refreshSeconds", 30)))

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color dim: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property bool vertical: bar ? bar.vertical : false
  // Panel does not provide these; BarWidget does. A widget rooted on Panel owns them.
  readonly property int barSize: bar ? bar.barSize : Style.bar.sizeHorizontal

  // ---------------------------------------------------------------- state
  property var snapshot: null
  /** Bound companies for the popup picker, fetched when the popup opens. */
  property var companies: []
  /** Dot last-activity, fetched on open: a nudge, never evidence. */
  property var dotPresence: null
  property double nowMs: Date.now()
  property string lastError: ""
  property bool busy: false
  /**
   * What the time was for. This is the ledger's one free-text field (single line,
   * at most 200 characters, exactly the CLI's bound), typed by the person and
   * attached to the session either when clocking out or with Save note.
   */
  property string activity: ""

  readonly property string freshness: Workspan.staleness(snapshot, nowMs, refreshSeconds)
  readonly property bool online: freshness === "fresh"
  readonly property var warnings: Workspan.warnings(snapshot)
  /** The caption line, empty when there is nothing to nudge about. */
  readonly property string dotHint: Workspan.dotHint(root.dotPresence, root.snapshot, root.nowMs)
  /** The seat-idle nudge: an annotation that pauses nothing, so it only reports. */
  readonly property string idleHint: Workspan.idleHint(root.snapshot, root.nowMs)
  /** What the day report cannot speak for: a review list, never a subtraction. */
  readonly property string uncoveredHint: Workspan.uncoveredHint(root.snapshot)
  readonly property string barText: root.vertical ? Workspan.barLabelVertical(root.snapshot) : Workspan.barLabel(root.snapshot)
  /** One entry per stacked line, the way the stock clock splits its vertical format. */
  readonly property var verticalLines: root.vertical ? root.barText.split("\n") : []
  readonly property bool sessionOpen: !!(snapshot && snapshot.current_session)
  readonly property bool sessionPaused: !!(snapshot && snapshot.current_session && snapshot.current_session.state === "paused")

  // The stock clock's sizing: the widget mirrors its button, and the button
  // measures itself from the label, one iconSlot per stacked line when vertical.
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  // A popup is owned by the bar's popout coordinator: without registering it on
  // open, the surface is created and immediately released again. This mirrors the
  // working third-party widget (carlotran4.herdr).
  function open() {
    controller.show()
    if (bar && typeof bar.requestPopout === "function") bar.requestPopout(root)
  }

  function close() {
    controller.hide()
    if (bar && typeof bar.releasePopout === "function") bar.releasePopout(root)
  }

  function refreshNow() { statusView.reload() }

  // Commands are an argv array: no shell text is interpolated, and the plugin
  // never writes to the database itself.
  function runCli(args) {
    if (cliProcess.running) return
    root.lastError = ""
    root.busy = true
    cliProcess.command = [root.cliPath, "--socket", root.socketFile].concat(args)
    cliProcess.running = true
  }

  function startSession() {
    root.runCli(root.project === "" ? ["session", "start"] : ["session", "start", "--project", root.project])
  }

  function stopSession() {
    var value = root.sessionOpen ? String(root.snapshot.current_session.session || "") : ""
    var args = value === "" ? ["session", "stop"] : ["session", "stop", "--session", value]
    // Clock out carries the activity: it is written as the session note on the way
    // out, and cleared once it is recorded so the next session starts blank.
    var note = root.activity.trim()
    if (note !== "") args = args.concat(["--note", note])
    root.activity = ""
    root.runCli(args)
  }

  /** Attach the typed activity to the running session without stopping it. */
  function saveNote() {
    var note = root.activity.trim()
    if (note === "") return
    root.activity = ""
    root.runCli(["note", note])
  }

  function toggleSession() { root.sessionOpen ? root.stopSession() : root.startSession() }

  function pauseOrResume() {
    if (!root.sessionOpen) return
    root.runCli(root.sessionPaused ? ["session", "resume"] : ["session", "pause"])
  }

  FileView {
    id: statusView
    path: root.statusFile
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.snapshot = Workspan.parseStatus(text())
    onLoadFailed: root.snapshot = null
  }

  onOpenedChanged: if (opened) {
    fetchCompanies()
    fetchSignals()
  }

  function fetchCompanies() {
    if (!projectsProcess.running) projectsProcess.running = true
  }

  function fetchSignals() {
    if (!signalsProcess.running) signalsProcess.running = true
  }

  function projectClicked(project) {
    root.runCli(root.sessionOpen ? ["session", "switch", "--project", project] : ["session", "start", "--project", project])
  }

  Process {
    id: projectsProcess
    running: false
    command: [root.cliPath, "--socket", root.socketFile, "projects", "--json"]
    stdout: StdioCollector { id: projectsOut; waitForEnd: true
      onStreamFinished: {
        var bindings = []
        try { bindings = JSON.parse(String(projectsOut.text || "[]")) } catch (error) { bindings = [] }
        root.companies = Workspan.companyRows(bindings, root.snapshot)
      }
    }
    // Only a non-empty stderr is a failure: the empty case fires on every exit
    // and must not wipe the rows stdout just delivered.
    stderr: StdioCollector { id: projectsErr; waitForEnd: true
      onStreamFinished: {
        if (String(projectsErr.text || "").trim() !== "") root.companies = []
      }
    }
  }

  // Presence is not attendance: this one timestamp is read for the caption and
  // nothing else. It is never stored and no measure ever sees it.
  Process {
    id: signalsProcess
    running: false
    command: [root.cliPath, "--socket", root.socketFile, "signals"]
    stdout: StdioCollector { id: signalsOut; waitForEnd: true
      onStreamFinished: {
        var parsed = null
        try { parsed = JSON.parse(String(signalsOut.text || "")) } catch (error) { parsed = null }
        root.dotPresence = parsed && parsed.dot ? parsed.dot : null
      }
    }
    stderr: StdioCollector { id: signalsErr; waitForEnd: true
      onStreamFinished: {
        if (String(signalsErr.text || "").trim() !== "") root.dotPresence = null
      }
    }
  }

  Timer {
    interval: root.refreshSeconds * 1000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: {
      root.nowMs = Date.now()
      root.refreshNow()
    }
  }

  Process {
    id: cliProcess
    running: false
    stdout: StdioCollector { id: cliOut; waitForEnd: true }
    stderr: StdioCollector { id: cliErr; waitForEnd: true }
    onExited: function (code) {
      root.busy = false
      root.lastError = code === 0 ? "" : (Workspan.shortMessage(cliErr.text) || ("workspan exited with " + code))
      root.refreshNow()
    }
  }

  // ----------------------------------------------------------- bar button
  // The shell's own bar button, used the way the stock clock uses it: text when
  // horizontal, one OpticalGlyph per stacked line when vertical, with the
  // tooltip, press states and offline dimming the bar already provides.
  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.vertical ? "" : root.barText
    labelVisible: !root.vertical
    hasVisualContent: root.vertical ? root.verticalLines.length > 0 : true
    fixedHeight: root.vertical ? root.verticalLines.length * Style.bar.iconSlot : -1
    dimmed: !root.online
    tooltipText: Workspan.tooltip(root.snapshot, root.nowMs, root.refreshSeconds)

    onPressed: function (mouseButton) {
      if (mouseButton === Qt.RightButton) root.refreshNow()
      else if (mouseButton === Qt.MiddleButton) root.toggleSession()
      else root.toggle()
    }

    Column {
      visible: root.vertical
      anchors.fill: parent

      Repeater {
        model: root.verticalLines

        OpticalGlyph {
          required property string modelData
          width: button.width
          height: Style.bar.iconSlot
          text: modelData
          fontFamily: button.fontFamily
          fontSize: modelData.length > 3 ? button.fontSize * 0.9 : button.fontSize
          color: root.online ? button.foreground : Qt.rgba(button.foreground.r, button.foreground.g, button.foreground.b, 0.55)
        }
      }
    }
  }

  // ---------------------------------------------------------------- popup
  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    // Qualified by id, as the first-party panel does: unqualified calls in this
    // binding do not resolve and leave the card at its default size.
    contentWidth: panel.fittedContentWidth(Style.space(340))
    contentHeight: panel.fittedContentHeight(panelContent.implicitHeight, Style.space(620))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onActivateRequested: root.refreshNow()
      onTabRequested: function (direction) { root.switchPanel(direction) }

      Flickable {
        anchors.fill: parent
        contentWidth: width
        contentHeight: panelContent.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick

        Column {
          id: panelContent
          width: parent.width
          spacing: Style.space(12)

          PanelHero {
            width: parent.width
            title: "Workspan"
            meta: Workspan.sessionLine(root.snapshot)
            detail: root.online ? "" : "The daemon is not writing status. Start it with: workspan daemon"
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          // The primary action, first in the card. Clocking in and out is what a
          // person opens this popup to do, so it never sits below the advisory text
          // or the measures: the label names the act, and the hero above keeps the
          // ledger vocabulary and the running time.
          Row {
            width: parent.width
            spacing: Style.space(8)

            Button {
              text: root.sessionOpen ? "Clock out" : "Clock in"
              bordered: true
              foreground: root.foreground
              fontFamily: root.fontFamily
              enabled: !root.busy
              onClicked: root.sessionOpen ? root.stopSession() : root.startSession()
            }

            Button {
              visible: root.sessionOpen
              text: root.sessionPaused ? "Resume" : "Pause"
              bordered: true
              foreground: root.foreground
              fontFamily: root.fontFamily
              enabled: !root.busy
              onClicked: root.pauseOrResume()
            }

            // The session controls that were here before stay here: Clock out
            // carries the activity, Stop is the plain stop.
            Button {
              visible: root.sessionOpen
              text: "Stop"
              bordered: true
              foreground: root.foreground
              fontFamily: root.fontFamily
              enabled: !root.busy
              onClicked: root.stopSession()
            }

            Button {
              visible: root.sessionOpen && root.activity.trim() !== ""
              text: "Save note"
              bordered: true
              foreground: root.foreground
              fontFamily: root.fontFamily
              enabled: !root.busy
              onClicked: root.saveNote()
            }

            Button {
              text: "Refresh"
              bordered: true
              foreground: root.foreground
              fontFamily: root.fontFamily
              onClicked: root.refreshNow()
            }
          }

          // The activity rides with the clock action: Clock out writes it as the
          // session note, Save note attaches it to the running session, and Enter
          // does whichever of the two the current state allows. The 200-character
          // cap is the daemon's own bound for the note.
          TextField {
            width: parent.width
            placeholderText: "What were you doing? (saved on Clock out)"
            foreground: root.foreground
            font.family: root.fontFamily
            text: root.activity
            maximumLength: 200
            enabled: !root.busy
            onTextChanged: root.activity = text
            onAccepted: root.sessionOpen ? root.saveNote() : root.startSession()
          }

          // The return-from-idle nudge: what the seat saw while nobody typed. It
          // reports; pausing or correcting the session stays the person's decision.
          Text {
            width: parent.width
            text: root.idleHint
            visible: root.idleHint !== ""
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }

          // What the day report cannot account for. The person decides what it was;
          // nothing here was removed from any total.
          Text {
            width: parent.width
            text: root.uncoveredHint
            visible: root.uncoveredHint !== ""
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }

          // The company picker: what the menu row does, one click away in the
          // popup. Clicking starts or switches, whichever the session needs.
          Column {
            width: parent.width
            spacing: Style.space(4)
            visible: root.companies.length > 0

            Text {
              // The Dot nudge: presence, never attendance. It says what the app
              // left behind; only the user starts anything.
              text: root.dotHint
              visible: root.dotHint !== ""
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }

            Text {
              text: "Project"
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }

            Repeater {
              model: root.companies

              Row {
                id: companyRow
                required property var modelData
                width: panelContent.width
                spacing: Style.space(4)

                Rectangle {
                  width: companyRow.modelData.active ? Style.space(3) : 0
                  height: projectLabel.implicitHeight
                  color: root.foreground
                  visible: companyRow.modelData.active
                }

                Text {
                  id: projectLabel
                  text: companyRow.modelData.project
                  color: companyRow.modelData.active ? root.foreground : root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                  width: parent.width - parent.spacing
                  elide: Text.ElideRight

                  MouseArea {
                    anchors.fill: parent
                    cursorShape: Qt.PointingHandCursor
                    onClicked: {
                      root.projectClicked(companyRow.modelData.project)
                      root.close()
                    }
                  }
                }
              }
            }
          }

          Column {
            width: parent.width
            spacing: Style.space(10)

            Repeater {
              model: Workspan.displayRows(root.snapshot)

              Column {
                id: measureRow
                required property var modelData
                width: panelContent.width
                spacing: Style.space(2)

                Row {
                  width: parent.width

                  Text {
                    text: measureRow.modelData.label
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                    width: parent.width - amount.implicitWidth
                    elide: Text.ElideRight
                  }

                  Text {
                    id: amount
                    text: measureRow.modelData.value
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                    font.bold: true
                  }
                }

                // One project per row: a joined line truncates the first project
                // name it runs out of room for, and every one of them is a client.
                Repeater {
                  model: measureRow.modelData.projects

                  Row {
                    required property var modelData
                    width: panelContent.width
                    spacing: Style.space(4)

                    Text {
                      text: parent.modelData.project
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      width: parent.width - projectMs.implicitWidth
                      elide: Text.ElideRight
                    }

                    Text {
                      id: projectMs
                      text: Workspan.formatDuration(parent.modelData.ms)
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                    }
                  }
                }

                Text {
                  visible: measureRow.modelData.caveats.length > 0
                  text: measureRow.modelData.caveats.join("   ")
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  width: parent.width
                  elide: Text.ElideRight
                }
              }
            }
          }

          Column {
            width: parent.width
            spacing: Style.space(6)

            PanelSeparator { foreground: root.foreground }

            Text {
              text: Workspan.NON_ADDITIVE
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              width: parent.width
              wrapMode: Text.WordWrap
            }

            Text {
              visible: Workspan.engineLine(root.snapshot) !== ""
              text: Workspan.engineLine(root.snapshot)
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              width: parent.width
              elide: Text.ElideRight
            }

            Repeater {
              model: root.warnings

              Text {
                required property string modelData
                text: "- " + modelData
                color: root.foreground
                opacity: 0.8
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                width: panelContent.width
                wrapMode: Text.WordWrap
              }
            }

            Text {
              visible: root.lastError !== ""
              text: root.lastError
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              width: parent.width
              wrapMode: Text.WordWrap
            }
          }
        }
      }
    }
  }
}
