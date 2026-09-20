if test -z "$HERDR_PANE_ID"
  return
end

set -l _hcwd_self (status filename)
set -g _hcwd_root (dirname (dirname (realpath $_hcwd_self)))

if test ! -f $_hcwd_root/bin/herdr-cwd.js
  return
end

if set -q XDG_STATE_HOME
  set -g _hcwd_state_dir "$XDG_STATE_HOME/herdr/plugins/herdr-cwd"
else
  set -g _hcwd_state_dir "$HOME/.local/state/herdr/plugins/herdr-cwd"
end
set -g _hcwd_pidfile ''
set -g _hcwd_key_resolved 0

function _hcwd_socket_path --description 'herdr socket this pane belongs to'
  if set -q HERDR_SOCKET_PATH; and test -n "$HERDR_SOCKET_PATH"
    echo $HERDR_SOCKET_PATH
    return
  end
  set -l base "$HOME/.config/herdr"
  if set -q XDG_CONFIG_HOME; and test -n "$XDG_CONFIG_HOME"
    set base "$XDG_CONFIG_HOME/herdr"
  end
  if set -q HERDR_SESSION; and test -n "$HERDR_SESSION"
    echo "$base/sessions/$HERDR_SESSION/herdr.sock"
  else
    echo "$base/herdr.sock"
  end
end

function _hcwd_resolve_key --description 'hash the socket path into the pidfile name, once per shell'
  set -l tool ''
  for candidate in sha1sum shasum
    if command -v $candidate >/dev/null 2>&1
      set tool $candidate
      break
    end
  end
  if test -n "$tool"
    set -l key (printf '%s' (_hcwd_socket_path) | $tool | cut -c1-12)
    if test (string length -- "$key") -eq 12
      set -g _hcwd_pidfile "$_hcwd_state_dir/daemon-$key.pid"
      return
    end
  end
  set -g _hcwd_pidfile ''
end

function _hcwd_alive --argument-names file
  test -f "$file"; or return 1
  set -l pid (cat "$file" 2>/dev/null)
  test -n "$pid"; or return 1
  kill -0 "$pid" 2>/dev/null
end

function _hcwd_ensure --on-event fish_prompt --description 'start the herdr-cwd daemon when this socket has none'
  if test $_hcwd_key_resolved -eq 0
    set -g _hcwd_key_resolved 1
    _hcwd_resolve_key
  end
  if test -n "$_hcwd_pidfile"
    if _hcwd_alive "$_hcwd_pidfile"
      return 0
    end
  else
    for file in $_hcwd_state_dir/daemon-*.pid
      if _hcwd_alive "$file"
        return 0
      end
    end
  end
  node "$_hcwd_root/bin/herdr-cwd.js" start --quiet >/dev/null 2>&1
end
