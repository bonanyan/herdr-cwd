[[ -n ${HERDR_PANE_ID:-} ]] || return 0

_hcwd_self="${(%):-%N}"
_hcwd_root="${_hcwd_self:A:h:h}"
unset _hcwd_self

[[ -f $_hcwd_root/bin/herdr-cwd.js ]] || return 0

_hcwd_state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/herdr/plugins/herdr-cwd"
_hcwd_pidfile=''
_hcwd_key_resolved=0

_hcwd_socket_path() {
  if [[ -n ${HERDR_SOCKET_PATH:-} ]]; then
    print -r -- "$HERDR_SOCKET_PATH"
    return
  fi
  local base="${XDG_CONFIG_HOME:-$HOME/.config}/herdr"
  if [[ -n ${HERDR_SESSION:-} ]]; then
    print -r -- "$base/sessions/$HERDR_SESSION/herdr.sock"
  else
    print -r -- "$base/herdr.sock"
  fi
}

_hcwd_resolve_key() {
  _hcwd_key_resolved=1
  local tool sock key
  for tool in sha1sum shasum; do
    (( $+commands[$tool] )) || continue
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
  pid=$(<$file) 2>/dev/null || return 1
  [[ -n $pid ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

_hcwd_ensure() {
  (( _hcwd_key_resolved )) || _hcwd_resolve_key
  local file
  if [[ -n $_hcwd_pidfile ]]; then
    _hcwd_alive "$_hcwd_pidfile" && return 0
  else
    for file in $_hcwd_state_dir/daemon-*.pid(N); do
      _hcwd_alive "$file" && return 0
    done
  fi
  ( node "$_hcwd_root/bin/herdr-cwd.js" start --quiet >/dev/null 2>&1 & )
}

autoload -Uz add-zsh-hook
add-zsh-hook precmd _hcwd_ensure
