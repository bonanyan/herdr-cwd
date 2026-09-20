# Changelog

All notable changes to this project are documented here. This project tries to follow
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [SemVer](https://semver.org/spec/v2.0.0.html).

## [0.3.0]

### Changed

- **Roughly 6x faster reaction.** A `cd` in the focused pane now reaches the host terminal in
  ~75 ms median instead of ~450 ms (measured on macOS, herdr 0.9.1, Otty 1.5.0). The poll interval
  dropped from 500 ms to 100 ms, and each poll asks for `pane.list` (~1.3 KB) instead of
  `session.snapshot` (~6 KB).
- **Adaptive transport.** `transport = "auto"` benchmarks the raw Unix socket against
  `HERDR_BIN_PATH` at startup and re-checks every 60 s, then uses whichever answers faster. On
  Node 26 + herdr 0.9.1 a socket request takes ~105 ms while the CLI takes ~5 ms, so the CLI wins
  there; where the socket is fast (~0.2 ms) it is used instead. `"socket"` and `"cli"` force one.
- **The focused pane is resolved from `pane.list`'s `focused` flag** rather than `pane.current`,
  which herdr resolves against the caller's `HERDR_PANE_ID`. A daemon started from inside a pane
  would otherwise have tracked that pane forever instead of the one on screen.
- `idle_poll_ms` 5000 -> 2000 and `tty_refresh_ms` 5000 -> 2000, with per-pid terminal env lookups
  cached, so a newly attached client is picked up sooner and rescans stay cheap.
- Runtime state is written at most once per `state_flush_ms` (1 s) unless something changed, so a
  100 ms poll does not turn into disk churn.

### Added

- `bench` command: measures the herdr round trip over both transports.
- Latency telemetry in the runtime state (`rtt_avg_ms`, `rtt_max_ms`, `reaction_avg_ms`,
  `reaction_max_ms`, `active_transport`, `transport_reason`), surfaced by `status`, `monitor`, and
  `doctor`.
- Config keys `transport`, `socket_timeout_ms`, and `state_flush_ms`, plus the
  `HERDR_CWD_TRANSPORT` and `HERDR_CWD_SOCKET_TIMEOUT_MS` overrides.
- `lib/socket.js`: a newline-delimited JSON client for `HERDR_SOCKET_PATH` with chunk reassembly,
  request-id matching, timeouts, and herdr error codes — covered by 8 tests against a fake server,
  plus transport-selection and fallback tests in `test/herdr.test.js`.
- A README **Latency** section documenting where the time goes and how to tune it.

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
