# Workspan (Omarchy plugin)

A bar widget and popup for the local Workspan daemon. It is **strictly a display**:
the daemon owns the database, the session state and the report; this plugin reads
one file and calls one CLI.

```
~/.config/omarchy/plugins/workspan.tracker/   this directory
$XDG_RUNTIME_DIR/workspan/status.json         written by the daemon (atomic rename)
$XDG_RUNTIME_DIR/workspan/workspan.sock       the daemon socket, used by the CLI
```

## What it shows

| Surface | Content |
| --- | --- |
| Bar | The strongest *attended* evidence (attested if any, else inferred) as `1:05`; dimmed with a dot when the daemon has stopped writing, plus an optional glyph |
| Tooltip | All three measures side by side, and the sentence that they are never added together |
| Popup | **Clock in / Clock out** first, with Pause/Resume, Stop, Refresh and Save note, plus the activity field that rides with them. Then the session line with state and provisional time, each measure against the projects it is allocated to, unallocated and ambiguous evidence, coverage warnings, and the seat-idle nudge |

For a single key or menu row, `workspan session toggle` starts when nothing is open and stops
what is open. The Omarchy menu already carries both paths: **Start / stop tracking**
(`workspan session toggle`) and **Track for company…** (`workspan session pick`). The bar
tooltip names the shortcut: a middle click on the widget toggles the session without
opening the popup.

Outside-harness work (a browser, ChatGPT, a call) has no workspace to derive, so
`workspan session pick` lists the bound companies on the shell's own picker and
switches the session to the chosen one; `workspan note <text>` and
`workspan session stop --note <text>` record what the time was for.
`workspan day` renders the day: sessions with notes and excluded pauses, the
three measures separately, never a sum.

Agent runtime never appears as the bar number: an agent running unattended is not
time worked, so it is shown in the popup with its own label.

- A Dot nudge: when the ChatGPT app's Dot profile was active in the last 15
  minutes and nothing is being tracked, the popup says so with a caption. It is
  presence, not attendance - it starts nothing, names no client and stores nothing.
- An idle nudge: when the collector reports a *finished* stretch with no seat input,
  the popup says for how long, for 15 minutes after the seat woke. A stretch with no
  resume is not asserted - a stopped collector looks the same as a quiet desk - and
  the day report labels it `no resume recorded`. It pauses nothing and subtracts
  nothing: whether that stretch was a break is the person's call. Answer it with
  `workspan note --idle "lunch"`, which lands on the session the stretch fell in.

The popup's activity field is that same note: one line, at most 200 characters, typed by
the person - the ledger's only free text. **Clock out** writes it as the session note and
clears the field; **Save note** attaches it to the running session without stopping it.
Attribution stays the company picker: nothing is inferred from what you type.
- A "not counted" caption: when no measure covers half an hour or more of the day,
  the popup says how much. It is the review list from `workspan day` - nothing was
  subtracted, and attesting the stretch is what changes a number.

## Deliberate choices

- **A status file, not a socket subscription.** `FileView` with `watchChanges` is
  the documented Omarchy pattern (see `omarchy.agents`) and it degrades honestly:
  if the daemon stops, the file stops moving and the widget says so instead of
  inventing totals. A direct subscription is a later optimisation.
- **The CLI for commands, as an argv array.** `Process` runs
  `[cliPath, "--socket", socketPath, ...]`; no shell text is ever interpolated,
  and the plugin never opens the database, so it cannot become a second writer.
- **The shell's own bar button.** The widget renders through `WidgetButton` and
  `OpticalGlyph` exactly like the stock clock: text when the bar is horizontal,
  one glyph per stacked line when it is vertical (`1h` over `05m`), with the
  bar's native tooltip, press states and offline dimming.

## Settings

```sh
omarchy bar set workspan.tracker cliPath /home/you/.local/bin/workspan
omarchy bar set workspan.tracker refreshSeconds 15 --json
omarchy bar set workspan.tracker glyph 'YOUR_GLYPH_HERE'
```

Leaving `statusFile` and `socketPath` empty uses the daemon defaults under
`$XDG_RUNTIME_DIR/workspan`.

## Install and update

Installing or enabling this plugin changes desktop configuration and is a separate,
explicitly approved step. The widget is user-owned shell code and lives in
`~/.config/omarchy/plugins/workspan.tracker/`:

```sh
omarchy plugin validate ./plugin
scripts/install-plugin.sh                    # this checkout
scripts/install-plugin.sh --from ~/Downloads/workspan.tracker-0.2.2.zip   # a release
scripts/install-plugin.sh --verify-only      # compare what is installed with the source
```

The script installs the four plugin files and fails unless every installed file matches
the source byte for byte - the check that catches a stale widget, which looks exactly
like a missing feature. A previous copy is backed up under
`~/.local/state/workspan/plugin-backups/`, never inside the plugins directory: a backup
there keeps the same manifest id, and two directories claiming `workspan.tracker` let
the bar resolve the widget to the stale copy. The shell reloads plugin code when
a file under that directory changes; force it with `omarchy-shell shell rescanPlugins`.

The plugin holds no durable state of its own: removing it loses nothing but the
display.
