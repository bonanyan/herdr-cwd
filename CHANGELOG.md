# Changelog

All notable changes to this project are documented here. This project tries to follow
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [SemVer](https://semver.org/spec/v2.0.0.html).

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
