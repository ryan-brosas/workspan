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
| Popup | Session controls (Start, Pause/Resume, Stop, Refresh), the session line with state and provisional time, each measure against the projects it is allocated to, unallocated and ambiguous evidence, coverage warnings |

For a single key or menu row, `workspan session toggle` starts when nothing is open and stops what is open.

Agent runtime never appears as the bar number: an agent running unattended is not
time worked, so it is shown in the popup with its own label.

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

## Scope

Installing or enabling this plugin changes desktop configuration and is a separate,
explicitly approved step:

```sh
omarchy plugin validate ./plugin
omarchy plugin add <git-url> --enable        # or copy into ~/.config/omarchy/plugins/
```

The plugin holds no durable state of its own: removing it loses nothing but the
display.
