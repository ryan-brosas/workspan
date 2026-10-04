# packaging

A designed launch contract for the Workspan daemon, kept in the repository so the
socket, state and sandboxing assumptions are reviewable before anyone installs
anything.

**Nothing here is installed or enabled.** Creating these files changes nothing on
the machine. Installing or enabling the unit — and any `shell.json` or desktop
change on the Omarchy side — is a separate, explicit approval.

## What the unit states

| Item | Value |
| --- | --- |
| Executable | `%h/.local/bin/workspan daemon --foreground` |
| Database | `%S/workspan/workspan.sqlite` (`$XDG_STATE_HOME`), dir 0700 |
| Socket and status file | `%t/workspan/` (`$XDG_RUNTIME_DIR`), dir 0700 |
| Restart | `on-failure`, 2s backoff |
| Boundary | no network (`AF_UNIX` only), no privileges, `$HOME` read-only except the state dir |
| Harness detection | on by default in the daemon entry point: probes each local agent history at start and every 5 minutes, importing into the ledger; `--no-harness` disables, `--harness-poll-ms` sets the poll cadence (minimum 1000 ms), `--harness-window-ms` how far back each pass reads (minimum 60000 ms, default 7 days), and `--spool-dir` the spool location (or `WORKSPAN_SPOOL_DIR`) |

The daemon reads the harness stores (`~/.codex`, `~/.claude`, opencode's database)
read-only under this sandbox. A store that cannot be read is named in that reader's
`error`; a store that is simply absent reports `available: false` - unavailable
never zero activity - in `status.harness` and by `workspan doctor`. The runtime
directory is preserved across daemon restarts (`RuntimeDirectoryPreserve=yes`) so a
running collector's sandbox does not lose its writable mount. On stop the daemon
removes its socket and leaves `status.json` in place: the widget reads a stale
status file as offline by freshness rather than by the file disappearing. Durable session state stays in SQLite, not this directory. The desktop
runtime spool does not survive logout/reboot; see [recovery](../docs/delivery.md).

## If it is ever installed

```sh
install -Dm644 packaging/workspan.service ~/.config/systemd/user/workspan.service
systemctl --user daemon-reload
systemctl --user enable --now workspan.service
systemctl --user status workspan.service
```

Then check, in this order: the daemon writes both state and runtime files, the CLI
answers over the socket, the plugin leaves its offline state, and stopping the
service returns the plugin to offline without losing session state.
`workspan doctor` answers the whole list in one command (add `--json` for scripts):
socket, daemon, status file, collector unit, its spool, automatic harness detection,
the conflict-review state (`coverage.conflicts`), each evidence source and the
database file. It reads; it never repairs.

For every new installation, confirm writing `%S/workspan` under
`ProtectHome=read-only` and the socket's actual mode rather than assuming that
prior host verification applies; those are the two items to check on a new host, and
the observations below record what has been verified on this one. The [optional backup timer](../docs/backup.md) is client-only and requires
its own installation/enabling approval.

## The collector unit

`workspan-collector.service` runs the native collector and pipes its evidence into
`collector-ingest.sh`, which spools lines until the daemon accepts them. Installing it is
the same explicit step as the daemon, and needs the built collector binary:

```sh
cargo build --release --manifest-path crates/collector/Cargo.toml
install -Dm755 crates/collector/target/release/workspan-collector ~/.local/bin/workspan-collector
install -Dm755 packaging/collector-ingest.sh ~/.local/share/workspan/collector-ingest.sh
install -Dm644 packaging/workspan-collector.service ~/.config/systemd/user/workspan-collector.service
systemctl --user daemon-reload
systemctl --user enable --now workspan-collector.service
```

| Item | Value |
| --- | --- |
| Executable | `%h/.local/bin/workspan-collector presence --interval-ms 5000 --idle-timeout-ms 300000` |
| Ingest loop | `%h/.local/share/workspan/collector-ingest.sh` (stdin to spool to `workspan ingest --stdin`) |
| Spool | `%t/workspan/collector.pending`, mode 0600, cleared only after the daemon accepts a batch |
| Restart | always, 5s backoff |
| Boundary | no network (AF_UNIX only), no privileges, `$HOME` read-only, writes only the spool |

The spool is the reconnect behavior. With the daemon stopped, lines stay on disk and
re-ingest as *duplicates* when it returns - identity is source+instance+session+event,
so nothing is lost and nothing is counted twice. A quiet seat sends nothing for a long
time, so a pending spool is retried on a 15-second timer and not only when the next line
arrives. `WORKSPAN_SOCKET` and `WORKSPAN_SPOOL` override the socket and spool for tests.

## Installed on this host

Recorded 2026-10-04, because a launch contract is only as good as the run it survived:

| Check | Result |
| --- | --- |
| `workspan.service` (daemon) | active, restarted onto the current source |
| `workspan-collector.service` | active, enabled at `graphical-session.target` |
| Collector process | running the exact `ExecStart` pipeline, journal shows the start |
| Evidence reaching the ledger | `coverage.sources` gains `desktop`; no measure moves |
| Spool | created 0600 in `%t/workspan`, cleared after an accepted batch, kept while the daemon is down |
| New daemon methods | `workspan note --idle` answers `no_idle_stretch` with no stretch on record, which the old daemon could not say |
| Ingest loop | writes a heartbeat every pass; a spool it cannot write exits non-zero so the unit restarts |
| Runtime directory | `RuntimeDirectoryPreserve=yes` on the daemon: without it a daemon restart recreates `%t/workspan` and the collector's sandbox writes EROFS while looking healthy (observed 2026-10-04) |

## Milestone 1

The first slice runs the daemon in the foreground from a terminal against a
fixture database. The unit exists so the eventual launch contract is fixed early;
it is not a prerequisite for the plugin work.
