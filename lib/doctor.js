'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const herdr = require('./herdr');
const lock = require('./lock');
const log = require('./log');
const osc7 = require('./osc7');
const paths = require('./paths');
const runtime = require('./state');
const tty = require('./tty');

const RC_FILES = [
  '~/.zshrc',
  '~/.zprofile',
  '~/.zshenv',
  '~/.bashrc',
  '~/.bash_profile',
  '~/.profile',
  '~/.config/fish/config.fish',
];

function detectShellHook() {
  const home = os.homedir();
  const files = [];
  for (const entry of RC_FILES) {
    const file = entry.replace(/^~/, home);
    let exists = false;
    let references = false;
    try {
      exists = fs.statSync(file).isFile();
      references = exists && /herdr-cwd/.test(fs.readFileSync(file, 'utf8'));
    } catch {}
    if (exists) files.push({ path: file, references });
  }
  return {
    shell: path.basename(process.env.SHELL || ''),
    login_shell_has_hook: files.some((file) => file.references),
    rc_files: files,
    hook_files: ['zsh', 'bash', 'fish'].map((shell) => path.join(paths.pluginRoot(), 'shell', `hook.${shell}`)),
  };
}

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
    const info = await herdr.focusedPane(cfg);
    const pane = info.pane;
    report.focused_pane = {
      method: info.method,
      transport: info.transport,
      rtt_ms: +info.rtt_ms.toFixed(2),
      pane_id: (pane && pane.pane_id) || '',
      workspace_id: (pane && pane.workspace_id) || '',
      tab_id: (pane && pane.tab_id) || '',
      agent: (pane && pane.agent) || '',
      cwd: (pane && pane.cwd) || '',
      foreground_cwd: (pane && pane.foreground_cwd) || '',
      terminal_title: (pane && pane.terminal_title) || '',
      chosen_cwd: herdr.pickCwd(pane, cfg.cwd_source),
    };
  } catch (err) {
    report.focused_pane = { error: `${err.code ? `${err.code}: ` : ''}${err.message}` };
  }

  try {
    const snap = await herdr.snapshot(cfg);
    report.snapshot = {
      version: (snap.snapshot && snap.snapshot.version) || '',
      protocol: (snap.snapshot && snap.snapshot.protocol) || null,
      pane_count: snap.snapshot && Array.isArray(snap.snapshot.panes) ? snap.snapshot.panes.length : 0,
      transport: snap.transport,
      rtt_ms: +snap.rtt_ms.toFixed(2),
    };
  } catch (err) {
    report.snapshot = { error: `${err.code ? `${err.code}: ` : ''}${err.message}` };
  }

  try {
    report.bench = await herdr.bench(cfg, 6);
  } catch (err) {
    report.bench = { error: err.message };
  }
  report.transport_health = herdr.transportHealth();

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

  report.shell_hook = detectShellHook();

  report.shell_hook = detectShellHook();

  const cwd = (report.focused_pane && report.focused_pane.chosen_cwd) || '';
  report.sequence = cwd ? { dir: cwd, host: cfg.host, ...osc7.describe(cwd, cfg.host) } : { note: 'no cwd to encode yet' };
  report.log_tail = log.tail(25);
  return report;
}

function line(label, value) {
  return `  ${label.padEnd(22)} ${value === undefined || value === '' ? '-' : value}`;
}

function benchText(entry) {
  if (!entry || !entry.samples) return `unavailable${entry && entry.error ? ` (${entry.error})` : ''}`;
  return `median ${entry.median_ms}ms  min ${entry.min_ms}  max ${entry.max_ms}  n=${entry.samples}${entry.error ? ` err=${entry.error}` : ''}`;
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
  if (report.focused_pane && report.focused_pane.error) {
    out.push(line('herdr error', report.focused_pane.error));
  } else if (report.focused_pane) {
    const fp = report.focused_pane;
    out.push(line('workspace', fp.workspace_id));
    out.push(line('tab', fp.tab_id));
    out.push(line('pane', fp.pane_id));
    out.push(line('cwd', fp.cwd));
    out.push(line('foreground_cwd', fp.foreground_cwd));
    out.push(line('chosen', fp.chosen_cwd || '(empty)'));
    out.push(line('herdr call', `${fp.method} via ${fp.transport} in ${fp.rtt_ms}ms`));
  }
  out.push('');
  out.push('latency:');
  out.push(line('poll interval', `${report.config.effective.poll_ms}ms (idle ${report.config.effective.idle_poll_ms}ms)`));
  out.push(line('configured transport', report.config.effective.transport));
  if (report.bench && report.bench.socket) out.push(line('bench socket', benchText(report.bench.socket)));
  if (report.bench && report.bench.cli) out.push(line('bench cli', benchText(report.bench.cli)));
  if (report.transport_health) {
    out.push(
      line(
        'transport health',
        `last=${report.transport_health.last_transport || '-'} ok=${report.transport_health.ok} failures=${report.transport_health.failures} calls=${report.transport_health.calls}${report.transport_health.last_error ? ` err=${report.transport_health.last_error}` : ''}`,
      ),
    );
  }
  if (report.runtime) {
    out.push(line('daemon herdr rtt', `avg ${report.runtime.rtt_avg_ms}ms max ${report.runtime.rtt_max_ms}ms`));
    out.push(line('daemon tick->write', `avg ${report.runtime.reaction_avg_ms}ms max ${report.runtime.reaction_max_ms}ms`));
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
  out.push('shell hook (optional, revives the daemon from a prompt):');
  out.push(line('login shell', report.shell_hook.shell));
  out.push(line('sourced from rc', report.shell_hook.login_shell_has_hook ? 'yes' : 'no'));
  for (const file of report.shell_hook.rc_files) {
    out.push(line(path.basename(file.path), file.references ? 'references herdr-cwd' : 'present'));
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
