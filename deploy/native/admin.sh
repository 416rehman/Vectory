#!/usr/bin/env bash
# Offline maintenance through this installation's prebuilt runtime libraries.
set -euo pipefail
[[ "$(id -u)" == 0 ]] || { printf 'Vectory: run this command with sudo.\n' >&2; exit 1; }
fail() { printf 'Vectory: %s\n' "$*" >&2; exit 1; }
for tool in systemctl realpath stat awk runuser; do command -v "$tool" >/dev/null || fail "Install $tool, then retry."; done
record=/etc/vectory-server/instance.conf
[[ -f "$record" && ! -L "$record" && "$(realpath -e "$record")" == "$record" && "$(stat -c %u:%a "$record")" == 0:600 ]] || fail 'No private root-owned native instance record.'
kit="$(awk -F= '$1=="KIT_ROOT" {print $2}' "$record")"
[[ "$kit" =~ ^/opt/vectory-server/[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || fail 'The retained native runtime path is invalid.'
parent="$kit"
while :; do
  [[ -d "$parent" && ! -L "$parent" && "$(realpath -e "$parent")" == "$parent" && "$(stat -c %u "$parent")" == 0 ]] || fail 'The native runtime must have unlinked root-owned ancestors.'
  mode="$(stat -c %a "$parent")"
  (( (8#$mode & 8#22) == 0 )) || fail 'The native runtime is writable by another account.'
  [[ "$parent" == / ]] && break
  parent="$(dirname -- "$parent")"
done
state="$(systemctl show vectory-native-server.service --property ActiveState --value)" || fail 'Could not check the native server service.'
help_only=
if [[ $# == 0 ]]; then set -- --help; help_only=1; fi
if [[ $# == 1 ]]; then case "$1" in help|--help|-h|--version|-V) help_only=1 ;; esac; fi
if [[ -z "$help_only" ]]; then
  case "$state" in inactive|failed) ;; *) fail 'Stop the native server before offline maintenance: sudo ./start.sh stop.' ;; esac
fi
for option in "$@"; do
  case "$option" in --data-dir|--data-dir=*) fail 'This wrapper selects the retained native data directory.' ;; esac
done
loader="$kit/server-root/lib64/ld-linux-x86-64.so.2"
admin="$kit/server-root/usr/local/bin/vectory-admin"
for file in "$loader" "$admin"; do
  [[ -f "$file" && ! -L "$file" && "$(realpath -e "$file")" == "$file" && "$(stat -c %u "$file")" == 0 ]] || fail 'The retained native executable is missing, linked or not root-owned.'
  mode="$(stat -c %a "$file")"
  (( (8#$mode & 8#22) == 0 )) || fail 'The retained native executable is writable by another account.'
done
for directory in "$(dirname -- "$loader")" "$(dirname -- "$admin")" "$kit/server-root/lib/x86_64-linux-gnu" "$kit/server-root/usr/lib/x86_64-linux-gnu"; do
  [[ ! -L "$directory" ]] || fail 'A native runtime library directory is linked.'
  [[ -e "$directory" ]] || continue
  parent="$directory"
  while [[ "$parent" != "$kit" ]]; do
    [[ -d "$parent" && ! -L "$parent" && "$(realpath -e "$parent")" == "$parent" && "$(stat -c %u "$parent")" == 0 ]] || fail 'Native runtime library directories must be unlinked and root-owned.'
    mode="$(stat -c %a "$parent")"
    (( (8#$mode & 8#22) == 0 )) || fail 'Native runtime library directories are writable by another account.'
    parent="$(dirname -- "$parent")"
  done
done
exec runuser -u vectory-server -- "$loader" \
  --library-path "$kit/server-root/lib/x86_64-linux-gnu:$kit/server-root/usr/lib/x86_64-linux-gnu" \
  "$admin" --data-dir /var/lib/vectory-server/data "$@"
