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
  readonly property string glyph: String(setting("glyph", ""))
  readonly property string project: String(setting("project", ""))
  readonly property int refreshSeconds: Math.max(5, Number(setting("refreshSeconds", 30)))

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color dim: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property bool vertical: bar ? bar.vertical : false

  // ---------------------------------------------------------------- state
  property var snapshot: null
  property double nowMs: Date.now()
  property string lastError: ""
  property bool busy: false

  readonly property string freshness: Workspan.staleness(snapshot, nowMs, refreshSeconds)
  readonly property bool online: freshness === "fresh"
  readonly property var warnings: Workspan.warnings(snapshot)
  readonly property string barText: Workspan.barLabel(snapshot)
  readonly property bool sessionOpen: !!(snapshot && snapshot.current_session)

  implicitWidth: vertical ? barSize : Math.max(barSize, barRow.implicitWidth + Style.space(12))
  implicitHeight: barSize

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
    root.runCli(value === "" ? ["session", "stop"] : ["session", "stop", "--session", value])
  }

  function toggleSession() { root.sessionOpen ? root.stopSession() : root.startSession() }

  FileView {
    id: statusView
    path: root.statusFile
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.snapshot = Workspan.parseStatus(text())
    onLoadFailed: root.snapshot = null
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
  Rectangle {
    id: button
    anchors.fill: parent
    radius: Style.cornerRadius
    color: root.opened ? Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12) : "transparent"

    Behavior on color { ColorAnimation { duration: 120 } }

    Row {
      id: barRow
      anchors.centerIn: parent
      spacing: Style.space(5)

      Text {
        visible: root.glyph !== ""
        text: root.glyph
        color: root.foreground
        opacity: root.online ? 1 : 0.45
        font.family: root.fontFamily
        font.pixelSize: Style.bar.iconFont
        anchors.verticalCenter: parent.verticalCenter
      }

      Text {
        text: root.barText
        color: root.foreground
        opacity: root.online ? 1 : 0.55
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
        anchors.verticalCenter: parent.verticalCenter
      }

      Rectangle {
        visible: !root.online
        width: Style.space(5)
        height: width
        radius: width / 2
        color: root.foreground
        opacity: 0.5
        anchors.verticalCenter: parent.verticalCenter
      }
    }

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      acceptedButtons: Qt.LeftButton | Qt.RightButton | Qt.MiddleButton
      cursorShape: Qt.PointingHandCursor

      onEntered: if (root.bar) root.bar.showTooltip(button, Workspan.tooltip(root.snapshot, root.nowMs, root.refreshSeconds))
      onExited: if (root.bar) root.bar.hideTooltip(button)
      onClicked: function (mouse) {
        if (root.bar) root.bar.hideTooltip(button)
        if (mouse.button === Qt.RightButton) root.refreshNow()
        else if (mouse.button === Qt.MiddleButton) root.toggleSession()
        else root.toggle()
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
    contentWidth: fittedContentWidth(Style.space(340))
    contentHeight: fittedContentHeight(panelContent.implicitHeight, Style.space(620))

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

          Row {
            width: parent.width
            spacing: Style.space(8)

            Button {
              text: root.sessionOpen ? "Stop session" : "Start session"
              bordered: true
              foreground: root.foreground
              fontFamily: root.fontFamily
              enabled: !root.busy
              onClicked: root.toggleSession()
            }

            Button {
              text: "Refresh"
              bordered: true
              foreground: root.foreground
              fontFamily: root.fontFamily
              onClicked: root.refreshNow()
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

                Text {
                  visible: measureRow.modelData.projects.length > 0
                  text: measureRow.modelData.projects.join("   ")
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
