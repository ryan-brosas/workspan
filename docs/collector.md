# Desktop collector (Rust)

`crates/collector` is the native boundary. It exists for two reasons: to answer what
*this* host actually exposes, and to turn compositor metadata into evidence the
daemon already understands.

It is deliberately small: `serde` and `serde_json` carry the evidence envelope, and a
pure-Rust Wayland client (`wayland-client`) is what lets it observe seat idle at all,
since that protocol is invisible without a client. libwayland is resolved at runtime,
so the binary still brings no runtime dependency of its own.

## What it is allowed to read

| Read | Never read |
| --- | --- |
| `activewindow` → `class`, `inhibitingIdle` | `title`, `initialTitle`, `xdgDescription`, `tags` |
| workspace and monitor indices | URLs, clipboard, keystrokes, screenshots |
| which Hyprland sockets exist | anything outside the compositor's own metadata |
| seat idle: "no input for at least the timeout" (`ext_idle_notifier_v1`) | which application had focus during that stretch, or whether the person was working |

The deserialized struct declares only the coarse fields, so the content-bearing ones
cannot be retained: a test feeds a window with a secret title, an initial title and an
`xdgDescription` and asserts the value leaving the module contains none of them, not
even the field names.

Application *identity* is compared in memory (to know when focus changed) and is never
emitted. `--apps` therefore refuses to run:

```
--apps needs an envelope field the daemon does not have yet; refusing to smuggle it into an event id
```

## Modes

```sh
cargo run --manifest-path crates/collector/Cargo.toml -- probe
cargo run --manifest-path crates/collector/Cargo.toml -- presence --once
cargo run --manifest-path crates/collector/Cargo.toml -- presence --interval-ms 5000
cargo run --manifest-path crates/collector/Cargo.toml -- presence --idle-timeout-ms 300000
```

`presence` writes evidence lines to stdout; `workspan ingest --file` takes them, which
keeps the collector free of any transport of its own for now.

## Probe result on this host

Recorded 2026-10-04 on Hyprland v0.56.2, because the architecture is explicit that a
reference project's support table is not a host test:

| Signal | Available | Source |
| --- | --- | --- |
| focus | yes | `hyprctl -j activewindow` |
| idle-inhibit | yes | `activewindow.inhibitingIdle` |
| lock | yes | `org.freedesktop.login1` |
| suspend | yes | `org.freedesktop.login1 PrepareForSleep` |
| workspace | yes | `.socket2.sock` present |
| wayland-idle (`ext_idle_notifier_v1`) | yes | bound on this seat; idle reported after 300000 ms without input |

The idle answer used to read "unknown": without a Wayland client this build could not
see the registry, so it refused to guess. The client added for it binds the notifier,
lets go, and so answers available or unavailable *with the reason*. Lock and suspend
still arrive from logind. There is also no `hyprlock`, `hypridle` or `swayidle`
installed here, and only the event socket (`.socket2.sock`) exists — the command
channel is reached through `hyprctl`.

## Seat idle

`presence` also watches the seat through `ext_idle_notifier_v1`, on its own Wayland
connection and thread: the sampling loop must never wait on the compositor, and the
compositor must never wait on `hyprctl`. What it observes is "no keyboard or pointer
input for at least the timeout" — never which application had focus during it, and
never whether the person was working. Reading, a call and a meeting all look the same
from here, which is why this is an annotation and not a break.

The timeout defaults to five minutes: a minute at the desk is a pause, five is worth a
look, and no dialog is popped — the person decides. `0` is refused, and so is anything
beyond a day, because a quiet window that long is a wedged session or a suspend, and
logind reports those separately.

Transitions are evidence lines, not a state that has to be kept:

| Event id | Meaning |
| --- | --- |
| `idle:<at>:<timeout>` | the seat had been quiet for `timeout` ms; the quiet stretch began at `at - timeout` |
| `resumed:<at>:<timeout>` | input came back |
| `idle-unavailable:<at>` | this run cannot watch the seat (no Wayland display, no `ext_idle_notifier_v1`), so its silence is not evidence about idleness |

The subtraction is why the timeout travels in the event id at all: the protocol
guarantees the timeout elapsed before the notification fired, so `at - timeout` is a
provable start rather than a guess, and a reader without the number would understate
the gap. Nothing here is a measure: the stretch reaches the status file as
`last_idle`, a *finished* one (with a `resumed`) becomes the popup's "no input for…"
nudge, and the day report lists them all under `Away`, marking one that never saw a
resume. No total moves, and pausing automatically would be a policy decision this
collector deliberately does not take.

## Presence is not attendance

Every event the collector emits has `origin: "unknown"` and no `project`. The daemon
turns only *human* interaction into inferred work, so desktop evidence lands in
`coverage.sources` and changes no measure. Verified on this host:

```
before:  sources [manual, pi]                       inferred 900000  agent 0
 ingest  {"accepted": 2, "duplicates": 0, "conflicts": 0}
after:   sources [desktop, manual, pi]              inferred 900000  agent 0
```

Two presence events arrived, coverage recorded them, and the hours did not move.

The same holds for idle. `test/idle.test.ts` ingests a session, then an `idle`/`resumed`
pair, and asserts that the measures and the session are byte-for-byte what they were
while the annotation is added to coverage — and the day report grows an
`Away (seat idle annotations, never subtracted)` section beside the unchanged totals.
Both the nudge and that section need the collector to be running *and* its lines
ingested, which today is still the manual step below.

## Not wired yet

| Gap | Why it is not done |
| --- | --- |
| logind lock/suspend subscription | available on this host, but a D-Bus dependency or a `loginctl` reader has to be chosen deliberately |
| `.socket2.sock` event stream | its `activewindow>>` payload carries the window title, so it needs the same transient-read decision as anything else content-bearing |
| application identity in events | needs a bounded `app` field in the evidence envelope first |
| daemon transport, spooling | today the collector writes stdout and the CLI ingests; a direct socket client is a separate decision |
| idle as a break | never automatic: seat idle annotates (the popup nudge and the day report's `Away` section) and marks review boundaries; automatic pause is opt-in under an explicit policy |
