# herdr-cwd

Keep your **host terminal's** idea of the current directory in sync with the herdr pane you are
looking at.

[herdr](https://herdr.dev) is a terminal multiplexer for coding agents. Like every multiplexer, it
sits between your terminal emulator and your shells, and it consumes the `OSC 7` working-directory
reports those shells emit. The result: terminal features that are driven by the pane's cwd keep
pointing at the directory you launched `herdr` from, no matter how far you have `cd`'d inside.

This plugin re-emits `OSC 7` for the focused pane's real directory straight to the host terminal's
PTY, so those features follow you again.

```
shell in herdr pane  --OSC 7-->  herdr (consumes it, tracks pane.cwd)
                                     |
herdr-cwd daemon     --OSC 7-->  host terminal PTY   <-- this plugin
```

## What it fixes

Anything the terminal derives from the pane's cwd, for example:

| Terminal | Feature that starts working again |
| --- | --- |
| [Otty](https://otty.sh) | Details Panel (`Info` / `Git` / `Files`) follows the pane instead of staying at the launch folder; new tabs and splits inherit the right cwd |
| kitty / WezTerm / Ghostty / foot / contour | Window or tab title path, new-window/new-split cwd, shell-integration cwd tracking |
| Konsole / GNOME Terminal / others that read `OSC 7` | Profile directory, "open new tab here" |

Terminals that do not implement `OSC 7` simply ignore the sequence.

## Why not just fix the shell?

A `chpwd`/`precmd` hook inside the pane cannot reach the host terminal either: its output goes to
the herdr pane's PTY, which herdr renders as cells. The only way in is to write to the PTY that
herdr's **client** is attached to — which is what this plugin does. herdr already knows every pane's
live directory (`foreground_cwd` in its socket API), so the plugin reads that instead of touching
your shell startup files.

## Requirements

- herdr `>= 0.9.0`
- Node.js `>= 18` (no dependencies)
- macOS or Linux — the plugin writes to `/dev/ttysNNN` (macOS) or `/dev/pts/N` (Linux)

## Install

```sh
herdr plugin install bonanyan/herdr-cwd
```

Add `--yes` to skip the interactive preview (it lists every command the plugin declares):

```sh
herdr plugin install bonanyan/herdr-cwd --yes
```

Confirm what got registered:

```sh
herdr plugin list --plugin herdr-cwd
# 1 plugin installed:
# - herdr-cwd (Herdr CWD) enabled [github:bonanyan/herdr-cwd@<commit>]
#   config: /Users/you/.config/herdr/plugins/config/herdr-cwd
```

### Starting the daemon

Everything the plugin does happens in a small daemon. herdr runs `[[startup]]` hooks **only when its
server starts** — not when a client attaches, not when the config reloads, and not when a plugin is
installed or enabled. So right after installing into an already-running server, start it once:

```sh
herdr plugin action invoke herdr-cwd.start
```

That is the only manual step, and only in that one situation. From then on the plugin keeps itself
alive:

- **Server start** — the `[[startup]]` hook starts the daemon.
- **Focus and pane lifecycle events** (`pane.focused`, `tab.focused`, `workspace.focused`,
  `pane.moved`, `pane.closed`, `tab.closed`, `workspace.closed`) run `nudge`, which pushes the new
  directory immediately *and* restarts the daemon if it died.
- **Everything else that happens in a session** (`pane.created`, `tab.created`, `workspace.created`,
  `pane.exited`, `pane.agent_detected`, `pane.agent_status_changed`, `workspace.updated`) runs
  `bin/watchdog.sh`: an ~8 ms `sh` check of the pidfile that spawns node only when no daemon is
  there. In a session with coding agents these fire constantly, so a dead daemon comes back within
  seconds.
- **herdr going away does not kill it.** Every poll is a fresh request, so a server restart, an
  update handoff, or a long detach just produces retries (backing off to 10 s) and it picks up
  again when herdr is back. Set `max_consecutive_errors` to a positive number if you would rather
  it exit.

### Optional: revive it from your shell

herdr has **no client-attach event**, and a plain `cd` emits nothing at all. So in a completely
quiet session — you attach, no agents are running, you never switch panes, you just `cd` — there is
no herdr-side signal to hang a restart on. If that is your workflow, source the optional shell
hook, which checks the pidfile on every prompt and revives the daemon when it is missing:

```zsh
# ~/.zshrc
for _f in $HOME/.config/herdr/plugins/github/herdr-cwd-*/shell/hook.zsh(N); do
  source $_f; break
done
```

```bash
# ~/.bashrc
for _f in "$HOME"/.config/herdr/plugins/github/herdr-cwd-*/shell/hook.bash; do
  [ -e "$_f" ] && . "$_f" && break
done
```

```fish
# ~/.config/fish/config.fish
for f in $HOME/.config/herdr/plugins/github/herdr-cwd-*/shell/hook.fish
  source $f
  break
end
```

From a clone instead of a GitHub install, source `shell/hook.<shell>` directly — each hook resolves
the plugin root from its own path.

The check is fork-free in the steady state (the shell reads the pidfile itself and `kill -0` is a
builtin); node is spawned only when the daemon is genuinely missing. The hook no-ops outside a
herdr pane. `doctor` reports whether your login shell sources it. zsh and bash hooks are
syntax-checked and behaviour-tested in CI; the fish hook is best-effort.

### Update

There is no `herdr plugin update` in plugin v1 — reinstalling is the update. It replaces the managed
checkout with the current default branch, but the running daemon keeps the old code in memory until
you restart it:

```sh
herdr plugin install bonanyan/herdr-cwd --yes
herdr plugin action invoke herdr-cwd.restart
```

### Where files live

| Path | Contents |
| --- | --- |
| `~/.config/herdr/plugins/github/herdr-cwd-<hash>/` | The managed checkout herdr runs (a `plugin link` points at your working copy instead) |
| `$(herdr plugin config-dir herdr-cwd)` | Your `config.json` |
| `~/.local/state/herdr/plugins/herdr-cwd/` | Per-socket pidfile, `runtime-<socket-hash>.json`, rotating `herdr-cwd.log` |

Config and state are keyed by plugin id, not by install source, so they survive an update, an
uninstall/reinstall, and switching between a GitHub install and a local link.

Working on the plugin itself? See [Development](#development) for running it out of a clone.

## Verify

```sh
herdr plugin action invoke herdr-cwd.doctor    # popup: herdr, config, daemon, terminals, byte dump
herdr plugin action invoke herdr-cwd.monitor   # popup: live view, refreshed once a second
herdr plugin action invoke herdr-cwd.status    # one-shot summary in the plugin log
```

Action output is captured by herdr; read it with:

```sh
herdr plugin log list --plugin herdr-cwd --limit 20
```

Or run the CLI directly from any pane:

```sh
node "$HERDR_PLUGIN_ROOT/bin/herdr-cwd.js" status
```

## Commands

| Command | What it does |
| --- | --- |
| `start` | Start the daemon if it is not already running |
| `stop` | Stop the daemon |
| `restart` | Stop, then start with the current config |
| `status` | Daemon state, focused pane cwd, discovered terminals |
| `emit` | Write `OSC 7` for the focused pane once, immediately |
| `nudge` | One-shot emit plus daemon watchdog (used by the event hooks) |
| `daemon` | Run the sync loop in the foreground (what `start` spawns) |
| `doctor` | Full diagnostics report |
| `bench` | Measure the herdr round trip over the socket and over the CLI |
| `monitor` | Live popup view (`q` to quit) |
| `open-monitor` / `open-doctor` | Open those as herdr popup panes |
| `config` | Print the effective config; `config --init` writes a template |

All of them accept `--json`, and `emit` accepts `--tty <device>` (repeatable) to target one
terminal instead of scanning.

## Configuration

Optional JSON at `$(herdr plugin config-dir herdr-cwd)/config.json`. Create a template with
`herdr-cwd config --init`. Every key has a working default.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `transport` | `"auto"` | How to talk to herdr: `auto` benchmarks both at startup (and re-checks every 60 s) and uses the faster one, `socket` forces the raw Unix socket, `cli` forces `HERDR_BIN_PATH` |
| `poll_ms` | `100` | Poll interval while a host terminal is attached |
| `idle_poll_ms` | `2000` | Poll interval when no host terminal is found, or when herdr calls fail (rising to 10 s after 12 consecutive failures) |
| `socket_timeout_ms` | `2000` | Per-request socket timeout before the transport is marked unhealthy |
| `state_flush_ms` | `1000` | Minimum gap between `runtime-*.json` writes when nothing changed |
| `tty_refresh_ms` | `2000` | How long the discovered terminal list is cached |
| `max_consecutive_errors` | `0` | Exit after this many consecutive herdr failures. `0` = never give up: the daemon keeps retrying through server restarts and long detaches |
| `cwd_source` | `"auto"` | `auto` = `foreground_cwd`, falling back to `cwd`; or force either one |
| `host` | `os.hostname()` | Host part of the `file://` URI |
| `ttys` | `[]` | Skip discovery and write to exactly these devices |
| `allow_term_programs` | `[]` | Only write to clients whose `TERM_PROGRAM` is in this list (empty = all) |
| `deny_term_programs` | `[]` | Never write to these `TERM_PROGRAM` values |
| `skip_nested_clients` | `true` | Ignore herdr clients running inside another herdr pane |
| `min_client_age_seconds` | `1` | Ignore `herdr` processes younger than this, so short-lived CLI calls are not mistaken for attached clients |
| `log_level` | `"info"` | `debug`, `info`, `warn`, `error`, or `off` |

Environment overrides (handy for one-off tests): `HERDR_CWD_DISABLED`, `HERDR_CWD_ENABLED`,
`HERDR_CWD_TRANSPORT`, `HERDR_CWD_POLL_MS`, `HERDR_CWD_IDLE_POLL_MS`, `HERDR_CWD_SOCKET_TIMEOUT_MS`,
`HERDR_CWD_SOURCE`, `HERDR_CWD_HOST`, `HERDR_CWD_TTY` (`:` or `,` separated),
`HERDR_CWD_TERM_PROGRAMS`, `HERDR_CWD_LOG_LEVEL`.

## How it works

1. A daemon (spawned detached from the `[[startup]]` hook, revived by the event hooks) asks herdr
   which pane is focused, every `poll_ms`.
2. It takes that pane's `foreground_cwd` (the live cwd of the process controlling the pane's PTY),
   falling back to `cwd`. The focused pane is the one herdr marks `focused: true` in `pane.list` —
   never the daemon's own caller pane, which is why the daemon can be started from anywhere.
3. It finds the host terminals: processes whose argv is an *attach* form of `herdr` (`herdr`,
   `herdr --session x`, `herdr session attach x`, `herdr --remote host`), that own a real tty, have
   lived longer than `min_client_age_seconds`, and are not nested inside another herdr pane.
4. When the directory changes, or when a new terminal appears, it writes
   `ESC ] 7 ; file://<host><percent-encoded-path> ESC \` to each device and remembers what it sent,
   so an unchanged directory is never rewritten.

Event hooks cover the rest. Focus and pane lifecycle events (`pane.focused`, `tab.focused`,
`workspace.focused`, `pane.moved`, `pane.closed`, `tab.closed`, `workspace.closed`) run `nudge`,
which emits immediately and restarts the daemon if it died. The busier events (`pane.created`,
`tab.created`, `workspace.created`, `pane.exited`, `pane.agent_detected`,
`pane.agent_status_changed`, `workspace.updated`) run `bin/watchdog.sh` instead: a POSIX-sh pidfile
check that only spawns node when nothing is running, so hooking frequent events costs ~8 ms each
instead of the ~30 ms a node start would.
The poll loop covers the case herdr has no event for at all: a plain `cd`.

State lives in `$(herdr plugin config-dir herdr-cwd)`'s sibling state directory: a pidfile per herdr
socket, a runtime JSON snapshot, and a rotating `herdr-cwd.log`. The snapshot is rewritten at most
every `state_flush_ms`, so a fast poll interval does not turn into disk churn.

## Latency

Measured on macOS, herdr 0.9.1, Otty 1.5.0: `cd` in the focused pane, then the moment the host
terminal reports the pane's new cwd (3 runs, median).

| Stage | 0.2.x | 0.3.0 |
| --- | --- | --- |
| herdr knows the new cwd | ~20 ms | ~21 ms |
| ... plus this plugin, end to end | **~450 ms** | **~75 ms** |

Where the time goes:

- **herdr's own detection, ~20 ms.** `foreground_cwd` is resolved when you ask for it, so an
  on-demand query is essentially fresh. herdr's *pushed* `pane.updated` events lag that by
  100-200 ms, which is why the plugin polls rather than waiting for events.
- **The poll interval: up to `poll_ms`.** At the default 100 ms this averages ~50 ms and dominates
  everything else. `poll_ms = 50` halves it for one extra herdr call every 50 ms.
- **Transport.** `transport = "auto"` benchmarks both paths at startup and re-checks every 60 s:
  - `cli` — spawn `HERDR_BIN_PATH pane list`, ~5 ms per call. The reliable one on macOS today.
  - `socket` — talk to `HERDR_SOCKET_PATH` directly, ~0.2 ms per call *when it behaves*. On
    Node 26 + herdr 0.9.1 the same request usually takes ~105 ms: the response sits in the socket
    buffer until something else wakes libuv's poll, while the identical request from Python or from
    the `herdr` CLI is answered in ~0.2 ms. `auto` measures this and picks the CLI, so a future
    combination that fixes it gets used automatically. `bench` prints both numbers.
- **The write, <1 ms** — one short escape sequence per terminal, only when the directory changed.

`status`, `monitor`, and `doctor` report the live numbers: which transport is in use and why, the
average and max herdr round trip, and the average and max tick-to-write time.

## Limitations

- **Local sessions only.** The daemon runs where the herdr *server* runs and writes to ttys on that
  machine. With `herdr --remote` / saved SSH machines, the client's tty is on your laptop while the
  server is elsewhere, so there is nothing to write to.
- **Another multiplexer in between.** If herdr itself runs inside tmux, the sequence reaches tmux,
  which drops it unless you enable `allow-passthrough` (and even then it needs tmux's DCS wrapper).
- **Writes share the PTY with herdr's renderer.** Each write is a single short, non-printing escape
  sequence; terminals apply it without drawing anything. If you ever see corruption, redraw
  (herdr does a full redraw on focus by default).
- **Pane processes that never report a cwd** fall back to whatever herdr recorded for the pane.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Nothing happens | `doctor`: is the daemon alive, is `enabled` true, does the socket exist? |
| Dead right after install | `[[startup]]` only runs when the herdr **server** starts, so run `herdr plugin action invoke herdr-cwd.start` once — see [Starting the daemon](#starting-the-daemon). |
| Dead in a quiet session | herdr emits nothing for a plain `cd` and has no client-attach event; add the [optional shell hook](#optional-revive-it-from-your-shell). |
| `terminals: none found` | `doctor` prints the `ps` scan it used. Attach a herdr client, or pin devices with `ttys` in the config. |
| Right terminal, wrong folder | `doctor` shows `cwd` vs `foreground_cwd` and which one was chosen; try `cwd_source = "cwd"`. |
| Works, then stops | `log_level = "debug"`, then read `herdr-cwd.log` (path printed by `doctor`). |
| Reacts slowly | `bench` compares both transports; `status` shows the live round trip and tick-to-write time. Lower `poll_ms`, and see [Latency](#latency). |
| Daemon exited | `max_consecutive_errors` is `0` (never give up) by default; if you raised it, the next event hook, shell hook, or `start` brings it back. |

## Uninstall

```sh
herdr plugin action invoke herdr-cwd.stop
herdr plugin uninstall herdr-cwd
```

Config and state directories are left behind; remove them if you want a clean slate (both paths are
printed by `doctor`).

## Development

### Link a working copy

`plugin link` runs the plugin straight out of your clone, so an edit only needs a daemon restart
instead of a release:

```sh
git clone https://github.com/bonanyan/herdr-cwd.git
cd herdr-cwd
herdr plugin link .
herdr plugin action invoke herdr-cwd.start
```

`plugin link` does not run `[[build]]` commands — you build the working tree yourself. This plugin
has no build step and no dependencies.

### Switch between a link and a GitHub install

Stop the daemon first so it releases its pidfile, then swap. `plugin unlink` only unregisters a
linked plugin and leaves your files alone; `plugin uninstall` also deletes the managed checkout:

```sh
herdr plugin action invoke herdr-cwd.stop
herdr plugin unlink herdr-cwd                      # local link     -> unregister only
herdr plugin install bonanyan/herdr-cwd --yes      # ...            -> GitHub install

herdr plugin action invoke herdr-cwd.stop
herdr plugin uninstall herdr-cwd                   # GitHub install -> drops the managed checkout
herdr plugin link ~/path/to/herdr-cwd              # ...            -> local link
```

Installing over a locally linked plugin is refused, so unlink before installing, and uninstall
before linking. Start the daemon again after either swap. Config and state are keyed by plugin id,
so nothing is lost by going back and forth.

### Run the CLI without touching the installed daemon

Point the variables herdr injects at throwaway directories, so a test run cannot grab the live
pidfile or write into the live log:

```sh
export HERDR_PLUGIN_ROOT=$PWD \
       HERDR_PLUGIN_CONFIG_DIR=/tmp/hcwd-cfg \
       HERDR_PLUGIN_STATE_DIR=/tmp/hcwd-state
node bin/herdr-cwd.js start && node bin/herdr-cwd.js status && node bin/herdr-cwd.js stop
```

### Layout

```
bin/herdr-cwd.js           argv dispatcher: start/stop/restart/status/emit/nudge/daemon/doctor/monitor/config
bin/watchdog.sh            cheap pidfile check the frequent event hooks run instead of node
lib/                       config, log, lock (per-socket pidfile), state, osc7, tty discovery, socket + herdr clients, daemon, doctor, monitor
shell/hook.{zsh,bash,fish} optional prompt-time watchdog for sessions that emit no herdr events
test/                      node --test suites, including watchdog.sh and the shell hooks
```

### Tests and diagnostics

```sh
npm test                        # node --test, no dependencies
node bin/herdr-cwd.js doctor    # full report against your live herdr session
node bin/herdr-cwd.js status --json
```

To publish a change: push to the default branch, then follow [Update](#update) on every machine —
reinstall, and restart the daemon so it drops the old code.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
