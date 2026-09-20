#!/bin/sh
set -u

plugin_root=${HERDR_PLUGIN_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}
state_dir=${HERDR_PLUGIN_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/herdr/plugins/herdr-cwd}

socket=${HERDR_SOCKET_PATH:-}
if [ -z "$socket" ]; then
  config_home=${XDG_CONFIG_HOME:-$HOME/.config}
  if [ -n "${HERDR_SESSION:-}" ]; then
    socket=$config_home/herdr/sessions/$HERDR_SESSION/herdr.sock
  else
    socket=$config_home/herdr/herdr.sock
  fi
fi

key=
for tool in sha1sum shasum; do
  if command -v "$tool" >/dev/null 2>&1; then
    key=$(printf '%s' "$socket" | "$tool" | cut -c1-12)
    break
  fi
done

is_alive() {
  pid=$(cat "$1" 2>/dev/null) || return 1
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

if [ -n "$key" ]; then
  if [ -f "$state_dir/daemon-$key.pid" ] && is_alive "$state_dir/daemon-$key.pid"; then
    exit 0
  fi
else
  for file in "$state_dir"/daemon-*.pid; do
    [ -e "$file" ] || continue
    is_alive "$file" && exit 0
  done
fi

exec node "$plugin_root/bin/herdr-cwd.js" start --quiet
