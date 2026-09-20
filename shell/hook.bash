[[ -n ${HERDR_PANE_ID:-} ]] || return 0

_hcwd_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -f $_hcwd_root/bin/herdr-cwd.js ]] || return 0

_hcwd_state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/herdr/plugins/herdr-cwd"
_hcwd_pidfile=''
_hcwd_key_resolved=0

_hcwd_socket_path() {
  if [[ -n ${HERDR_SOCKET_PATH:-} ]]; then
    printf '%s' "$HERDR_SOCKET_PATH"
    return
  fi
  local base="${XDG_CONFIG_HOME:-$HOME/.config}/herdr"
  if [[ -n ${HERDR_SESSION:-} ]]; then
    printf '%s' "$base/sessions/$HERDR_SESSION/herdr.sock"
  else
    printf '%s' "$base/herdr.sock"
  fi
}

_hcwd_resolve_key() {
  _hcwd_key_resolved=1
  local tool sock key
  for tool in sha1sum shasum; do
    command -v "$tool" >/dev/null 2>&1 || continue
    sock=$(_hcwd_socket_path)
    key=$(printf '%s' "$sock" | "$tool" 2>/dev/null | cut -c1-12 2>/dev/null)
    if [[ ${#key} -eq 12 ]]; then
      _hcwd_pidfile="$_hcwd_state_dir/daemon-$key.pid"
      return
    fi
    break
  done
  _hcwd_pidfile=''
}

_hcwd_alive() {
  local file=$1 pid
  [[ -f $file ]] || return 1
  pid=$(cat "$file" 2>/dev/null) || return 1
  [[ -n $pid ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

_hcwd_ensure() {
  [[ $_hcwd_key_resolved -eq 1 ]] || _hcwd_resolve_key
  local file
  if [[ -n $_hcwd_pidfile ]]; then
    _hcwd_alive "$_hcwd_pidfile" && return 0
  else
    for file in "$_hcwd_state_dir"/daemon-*.pid; do
      [[ -e $file ]] || continue
      _hcwd_alive "$file" && return 0
    done
  fi
  ( node "$_hcwd_root/bin/herdr-cwd.js" start --quiet >/dev/null 2>&1 & )
}

case ${PROMPT_COMMAND:-} in
  *_hcwd_ensure*) ;;
  *) PROMPT_COMMAND="_hcwd_ensure${PROMPT_COMMAND:+; $PROMPT_COMMAND}" ;;
esac
