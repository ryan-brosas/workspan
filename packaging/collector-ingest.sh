#!/usr/bin/env bash
# Workspan desktop collector -> the daemon, one batch at a time.
#
# The collector writes evidence lines on stdout; this script holds them in a spool and
# hands the spool to the CLI. A line leaves the spool only after the daemon accepted the
# batch, so a stopped daemon loses nothing: the same events re-ingest as duplicates when
# it comes back, because identity is source+instance+session+event.
#
# The spool is metadata only, like every other Workspan file, and it lives in the
# runtime directory so it disappears with the session.
#
# Two things this loop must never do: drop a line because a write failed, and look
# healthy while doing it. An unwritable spool exits non-zero so systemd restarts the
# pipeline, and a heartbeat is written every pass whether or not anything happened -
# a quiet seat sends nothing for hours, so evidence alone cannot tell a working lane
# from a broken one.
#
# WORKSPAN_SOCKET points the CLI at a non-default socket and WORKSPAN_SPOOL at a
# non-default spool; both exist for the tests.
set -uo pipefail
# The spool is metadata, like every other Workspan file, and stays for the user only.
umask 077

retry_seconds=15
spool="${WORKSPAN_SPOOL:-${XDG_RUNTIME_DIR:-/tmp}/workspan/collector.pending}"
health="${WORKSPAN_HEALTH:-$(dirname "$spool")/collector.health}"
mkdir -p "$(dirname "$spool")"
socket_args=()
if [ -n "${WORKSPAN_SOCKET:-}" ]; then socket_args=(--socket "$WORKSPAN_SOCKET"); fi

beat() { date +%s%3N > "$health" 2>/dev/null || true; }

while :; do
  beat
  IFS= read -r -t "$retry_seconds" line
  status=$?
  if [ "$status" -eq 0 ]; then
    if [ -n "$line" ]; then
      if ! printf '%s\n' "$line" >> "$spool"; then
        echo "workspan collector ingest: cannot write $spool; exiting so the unit restarts" >&2
        rm -f "$health"
        exit 1
      fi
    fi
  elif [ "$status" -le 1 ]; then
    # EOF: the collector stopped. Flush what is pending, or stop when nothing is.
    if [ ! -s "$spool" ]; then rm -f "$health"; exit 0; fi
    sleep "$retry_seconds"
  fi
  # A quiet seat sends nothing for a long time, so an unflushed spool is retried on
  # the timer, not only when the next line arrives.
  if [ -s "$spool" ] && workspan "${socket_args[@]}" ingest --stdin < "$spool" > /dev/null 2>&1; then
    : > "$spool"
  fi
done
