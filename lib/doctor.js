'use strict';

const os = require('node:os');
const fs = require('node:fs');
const herdr = require('./herdr');
const lock = require('./lock');
const log = require('./log');
const osc7 = require('./osc7');
const paths = require('./paths');
const runtime = require('./state');
const tty = require('./tty');

async function collect(cfg) {
  const report = {
    plugin: {
      id: paths.PLUGIN_ID,
      root: paths.pluginRoot(),
      node: process.version,
      platform: `${process.platform} ${os.release()}`,
    },
    herdr: {
      bin: paths.herdrBin(),
      socket_path: paths.socketPath(),
      socket_exists: fs.existsSync(paths.socketPath()),
      session_key: paths.sessionKey(),
    },
    config: { file: cfg.config_file, exists: fs.existsSync(cfg.config_file), effective: cfg },
    paths: { config_dir: paths.configDir(), state_dir: paths.stateDir(), log_file: log.logFile(), state_file: runtime.stateFile() },
    daemon: { ...lock.readStatus(), lock_file: lock.lockFile() },
    runtime: runtime.read(),
  };

  try {
    const snap = await herdr.snapshot();
    const pane = herdr.focusedPane(snap);
    report.snapshot = {
      version: (snap && snap.version) || '',
      protocol: (snap && snap.protocol) || null,
      focused_workspace_id: (snap && snap.focused_workspace_id) || '',
      focused_tab_id: (snap && snap.focused_tab_id) || '',
      focused_pane_id: (snap && snap.focused_pane_id) || '',
      pane_count: snap && Array.isArray(snap.panes) ? snap.panes.length : 0,
      focused_pane: pane
        ? { pane_id: pane.pane_id, cwd: pane.cwd || '', foreground_cwd: pane.foreground_cwd || '', agent: pane.agent || '', terminal_title: pane.terminal_title || '' }
        : null,
      chosen_cwd: herdr.paneCwd(pane, cfg.cwd_source),
    };
  } catch (err) {
    report.snapshot = { error: `${err.code ? `${err.code}: ` : ''}${err.message}` };
  }

  try {
    const found = await tty.discover(cfg, { force: true });
    report.terminals = {
      explicit_override: cfg.ttys,
      discovered: found,
      ps_style: process.platform === 'darwin' ? 'ps -ax -o tty=,pid=,etime=,command=' : 'ps -eo tty=,pid=,etime=,command=',
    };
  } catch (err) {
    report.terminals = { error: err.message };
  }

  const cwd = (report.snapshot && report.snapshot.chosen_cwd) || '';
  report.sequence = cwd ? { dir: cwd, host: cfg.host, ...osc7.describe(cwd, cfg.host) } : { note: 'no cwd to encode yet' };
  report.log_tail = log.tail(25);
  return report;
}

function line(label, value) {
  return `  ${label.padEnd(22)} ${value === undefined || value === '' ? '-' : value}`;
}

function render(report) {
  const out = [];
  out.push('herdr-cwd doctor');
  out.push('');
  out.push('plugin:');
  out.push(line('node', report.plugin.node));
  out.push(line('platform', report.plugin.platform));
  out.push(line('root', report.plugin.root));
  out.push('');
  out.push('herdr:');
  out.push(line('bin', report.herdr.bin));
  out.push(line('socket', `${report.herdr.socket_path}${report.herdr.socket_exists ? '' : '  (missing)'}`));
  out.push(line('version', (report.snapshot && report.snapshot.version) || (report.snapshot && report.snapshot.error) || ''));
  out.push('');
  out.push('config:');
  out.push(line('file', `${report.config.file}${report.config.exists ? '' : '  (absent, using defaults)'}`));
  out.push(line('enabled', String(report.config.effective.enabled)));
  out.push(line('cwd_source', report.config.effective.cwd_source));
  out.push(line('poll_ms', String(report.config.effective.poll_ms)));
  out.push(line('host', report.config.effective.host));
  out.push(line('ttys override', report.config.effective.ttys.join(', ')));
  out.push(line('allow programs', report.config.effective.allow_term_programs.join(', ')));
  out.push(line('deny programs', report.config.effective.deny_term_programs.join(', ')));
  out.push(line('log level', report.config.effective.log_level));
  out.push('');
  out.push('daemon:');
  out.push(line('pid', report.daemon.pid === null ? 'none' : String(report.daemon.pid)));
  out.push(line('alive', String(Boolean(report.daemon.alive))));
  out.push(line('lock file', report.daemon.lock_file));
  if (report.runtime) {
    out.push(line('started', report.runtime.started_at || ''));
    out.push(line('polls', String(report.runtime.polls === undefined ? '' : report.runtime.polls)));
    out.push(line('writes', String(report.runtime.writes === undefined ? '' : report.runtime.writes)));
    out.push(line('last cwd', report.runtime.cwd || ''));
    out.push(line('last write', report.runtime.last_write_at || 'never'));
    out.push(line('last error', report.runtime.last_error || ''));
  }
  out.push('');
  out.push('focused pane:');
  if (report.snapshot && report.snapshot.error) {
    out.push(line('snapshot error', report.snapshot.error));
  } else if (report.snapshot) {
    out.push(line('workspace', report.snapshot.focused_workspace_id));
    out.push(line('tab', report.snapshot.focused_tab_id));
    out.push(line('pane', report.snapshot.focused_pane_id));
    out.push(line('cwd', (report.snapshot.focused_pane && report.snapshot.focused_pane.cwd) || ''));
    out.push(line('foreground_cwd', (report.snapshot.focused_pane && report.snapshot.focused_pane.foreground_cwd) || ''));
    out.push(line('chosen', report.snapshot.chosen_cwd || '(empty)'));
  }
  out.push('');
  out.push('host terminals:');
  if (report.terminals && report.terminals.error) {
    out.push(line('error', report.terminals.error));
  } else {
    const list = (report.terminals && report.terminals.discovered) || [];
    out.push(line('scan', report.terminals ? report.terminals.ps_style : ''));
    if (!list.length) out.push(line('found', 'none'));
    for (const entry of list) {
      out.push(line(entry.path, `pid=${entry.pid} TERM_PROGRAM=${entry.term_program || '-'} age=${entry.age_seconds}s`));
    }
  }
  out.push('');
  out.push('sequence that would be written:');
  if (report.sequence && report.sequence.uri) {
    out.push(line('uri', report.sequence.uri));
    out.push(line('bytes', String(report.sequence.bytes)));
    out.push(line('escaped', report.sequence.escaped));
  } else {
    out.push(line('note', (report.sequence && report.sequence.note) || ''));
  }
  out.push('');
  out.push(`log tail (${report.paths.log_file}):`);
  for (const entry of report.log_tail.length ? report.log_tail : ['  (empty)']) out.push(`  ${entry}`);
  return `${out.join('\n')}\n`;
}

module.exports = { collect, render };
