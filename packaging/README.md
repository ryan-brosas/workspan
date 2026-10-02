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

The runtime directory is deliberate: stopping the service removes the socket and
`status.json`, which is exactly the signal the shell plugin shows as *offline*.
Nothing about the durable session state lives there.

## If it is ever installed

```sh
install -Dm644 packaging/workspan.service ~/.config/systemd/user/workspan.service
systemctl --user daemon-reload
systemctl --user enable --now workspan.service
systemctl --user status workspan.service
```

Then check, in this order: the daemon writes both state and runtime files, the CLI
answers over the socket, the plugin leaves its offline state, and stopping the
service returns the plugin to offline without losing session state. Two things are
still unverified and must be confirmed at that point rather than assumed: writing
`%S/workspan` while `ProtectHome=read-only` is active, and the socket's actual
mode after creation.

## Milestone 1

The first slice runs the daemon in the foreground from a terminal against a
fixture database. The unit exists so the eventual launch contract is fixed early;
it is not a prerequisite for the plugin work.
