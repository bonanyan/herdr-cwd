# Changelog

All notable changes to this project are documented here. This project tries to follow
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [SemVer](https://semver.org/spec/v2.0.0.html).

## [0.2.0]

### Added

- `bin/watchdog.sh`: a POSIX-sh pidfile check, keyed by the exact herdr socket, that spawns node only
  when no daemon is running. Hooked on the frequent events (`pane.created`, `tab.created`,
  `workspace.created`, `pane.exited`, `pane.agent_detected`, `pane.agent_status_changed`,
  `workspace.updated`), so a dead daemon comes back within seconds in any active session.
- Optional shell hooks (`shell/hook.zsh`, `hook.bash`, `hook.fish`) for sessions that emit no herdr
  events at all — herdr has no client-attach event and a plain `cd` emits nothing. The steady-state
  prompt check is fork-free.
- `doctor` now reports whether the login shell sources a hook, and lists the hook files.
- Tests for `watchdog.sh` (live, dead, foreign-socket, and no-sha1-tool cases) and for the shell
  hooks (parse checks plus zsh behaviour inside and outside a herdr pane).

### Changed

- `max_consecutive_errors` now defaults to `0` — never give up. The daemon retries through server
  restarts, update handoffs, and long detaches, backing off to 10 s after 12 failures, instead of
  exiting after 60 and leaving nothing to restart it.
- `min_client_age_seconds` lowered from `3` to `1` so a freshly attached client is picked up sooner.

## [0.1.0]

### Added

- Daemon that mirrors the focused herdr pane's working directory to every attached host terminal as
  `OSC 7`, so terminal file panels, titles, and new splits follow `cd` inside herdr.
- Host terminal discovery by scanning for attach-form `herdr` client processes that own a real tty,
  with age, nesting, and `TERM_PROGRAM` filters, plus an explicit `ttys` override.
- herdr plugin manifest: `[[startup]]` hook, `nudge` hooks on focus and pane lifecycle events,
  actions (`start`, `stop`, `restart`, `status`, `emit`, `doctor`, `monitor`), and `monitor` /
  `doctor` popup panes.
- `doctor` diagnostics (herdr socket, effective config, daemon state, focused pane cwd vs
  `foreground_cwd`, discovered terminals, byte-exact sequence, log tail) and a live `monitor` popup.
- JSON config file with environment overrides, per-socket pidfile, rotating log, and graceful exit
  after repeated herdr failures.
- Unit tests for the `OSC 7` encoder, the `ps` parser / client detection, and config loading.
