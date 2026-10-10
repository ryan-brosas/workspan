#!/usr/bin/env bash
# Install or update the Workspan bar widget for the current user.
#
# Usage:
#   scripts/install-plugin.sh                          install this checkout's plugin/
#   scripts/install-plugin.sh --from <release-zip>     install a released widget package
#   scripts/install-plugin.sh --verify-only            compare the installed copy with the source
#
# The widget is user-owned shell code: it lives in ~/.config/omarchy/plugins/, which the
# shell reloads when a file changes. Installing is therefore a copy plus a verification,
# never a service action.
set -euo pipefail

target="$HOME/.config/omarchy/plugins/workspan.tracker"
# Backups live outside the directory the shell scans. A copy inside it keeps the same
# manifest id, and the shell then has two plugins claiming workspan.tracker: the bar
# widget can resolve to the stale copy, which looks exactly like a missing feature.
backups="${XDG_STATE_HOME:-$HOME/.local/state}/workspan/plugin-backups"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_dir="$repo/plugin"
from=""
verify_only=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --from) from="${2:-}"; shift 2 ;;
    --verify-only) verify_only=true; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "install-plugin: unknown argument: $1" >&2; exit 2 ;;
  esac
done

work=""
# The EXIT trap's status becomes the script's status under `set -e`, so an empty
# work dir (every run without --from) must still leave a success, not a failed test.
cleanup() { [ -z "$work" ] || rm -rf "$work"; }
trap cleanup EXIT

if [ -n "$from" ]; then
  [ -f "$from" ] || { echo "install-plugin: no such artifact: $from" >&2; exit 2; }
  work="$(mktemp -d)"
  unzip -q "$from" -d "$work"
  source_dir="$work/workspan.tracker"
  [ -d "$source_dir" ] || { echo "install-plugin: $from does not contain workspan.tracker/" >&2; exit 2; }
fi

files=(manifest.json Panel.qml SessionControls.qml Draft.js Workspan.js README.md)
for name in "${files[@]}"; do
  [ -f "$source_dir/$name" ] || { echo "install-plugin: missing $source_dir/$name" >&2; exit 2; }
done

if ! $verify_only; then
  if [ -d "$target" ]; then
    mkdir -p "$backups"
    backup="$backups/$(basename "$target").bak.$(date +%s)"
    cp -a "$target" "$backup"
    echo "install-plugin: backed up the previous widget to $backup"
  fi
  install -d -m 700 "$target"
  for name in "${files[@]}"; do
    install -m 600 "$source_dir/$name" "$target/$name"
  done
  echo "install-plugin: installed $(jq -r .id "$target/manifest.json") $(jq -r .version "$target/manifest.json") into $target"
fi

status=0
for name in "${files[@]}"; do
  if ! cmp -s "$source_dir/$name" "$target/$name"; then
    echo "install-plugin: differs from the source: $name" >&2
    status=1
  fi
done
[ "$status" -eq 0 ] || { echo "install-plugin: installed widget does not match $source_dir" >&2; exit 1; }
echo "install-plugin: verified, the installed widget matches $source_dir"
if ! $verify_only; then
  echo "install-plugin: the shell reloads plugin code on change; force it with: omarchy-shell shell rescanPlugins"
fi
