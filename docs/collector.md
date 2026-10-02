# Desktop collector (Rust)

`crates/collector` is the native boundary. It exists for two reasons: to answer what
*this* host actually exposes, and to turn compositor metadata into evidence the
daemon already understands.

It is deliberately small and dependency-light (`serde`, `serde_json`) because a
collector that reads one compositor's metadata should not bring a runtime with it.

## What it is allowed to read

| Read | Never read |
| --- | --- |
| `activewindow` → `class`, `inhibitingIdle` | `title`, `initialTitle`, `xdgDescription`, `tags` |
| workspace and monitor indices | URLs, clipboard, keystrokes, screenshots |
| which Hyprland sockets exist | anything outside the compositor's own metadata |

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
```

`presence` writes evidence lines to stdout; `workspan ingest --file` takes them, which
keeps the collector free of any transport of its own for now.

## Probe result on this host

Recorded 2026-10-03 on Hyprland v0.56.2, because the architecture is explicit that a
reference project's support table is not a host test:

| Signal | Available | Source |
| --- | --- | --- |
| focus | yes | `hyprctl -j activewindow` |
| idle-inhibit | yes | `activewindow.inhibitingIdle` |
| lock | yes | `org.freedesktop.login1` |
| suspend | yes | `org.freedesktop.login1 PrepareForSleep` |
| workspace | yes | `.socket2.sock` present |
| wayland-idle (`ext_idle_notifier_v1`) | **unknown** | no Wayland client in this build |

The idle protocol answer is deliberately not invented: without a Wayland client this
build cannot see the registry, so it reports unavailable with that reason. Lock and
suspend arrive from logind instead. There is also no `hyprlock`, `hypridle` or
`swayidle` installed here, and only the event socket (`.socket2.sock`) exists — the
command channel is reached through `hyprctl`.

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

## Not wired yet

| Gap | Why it is not done |
| --- | --- |
| logind lock/suspend subscription | available on this host, but a D-Bus dependency or a `loginctl` reader has to be chosen deliberately |
| `.socket2.sock` event stream | its `activewindow>>` payload carries the window title, so it needs the same transient-read decision as anything else content-bearing |
| application identity in events | needs a bounded `app` field in the evidence envelope first |
| daemon transport, spooling | today the collector writes stdout and the CLI ingests; a direct socket client is a separate decision |
| idle as a break | never automatic: lock/idle annotate and mark review boundaries, and automatic pause is opt-in under an explicit policy |
