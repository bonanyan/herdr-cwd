'use strict';

const herdr = require('./herdr');
const lock = require('./lock');
const log = require('./log');
const runtime = require('./state');
const tty = require('./tty');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function show(value, fallback = '-') {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value);
}

function row(label, value) {
  return `  ${label.padEnd(18)} ${show(value)}`;
}

async function frame(cfg, counters) {
  const lines = [];
  lines.push('herdr-cwd monitor                                    press q to quit');
  lines.push('');

  const daemonState = lock.readStatus();
  const state = runtime.read() || {};
  lines.push('daemon');
  lines.push(row('pid', daemonState.pid === null ? 'none' : `${daemonState.pid}${daemonState.alive ? '' : ' (dead)'}`));
  lines.push(row('started', state.started_at));
  lines.push(row('polls / writes', `${show(state.polls, 0)} / ${show(state.writes, 0)}`));
  lines.push(row('last write', state.last_write_at));
  lines.push(row('last error', state.last_error));
  lines.push('');

  lines.push('focused pane');
  try {
    const snap = await herdr.snapshot({ timeout: 4000 });
    const pane = herdr.focusedPane(snap);
    lines.push(row('workspace', snap && snap.focused_workspace_id));
    lines.push(row('tab', snap && snap.focused_tab_id));
    lines.push(row('pane', snap && snap.focused_pane_id));
    lines.push(row('cwd', pane && pane.cwd));
    lines.push(row('foreground_cwd', pane && pane.foreground_cwd));
    lines.push(row('chosen', herdr.paneCwd(pane, cfg.cwd_source)));
    lines.push(row('agent', pane && pane.agent));
    counters.snapshotErrors = 0;
  } catch (err) {
    lines.push(row('snapshot error', err.message));
    counters.snapshotErrors += 1;
  }
  lines.push('');

  lines.push('host terminals');
  try {
    const found = await tty.discover(cfg, { force: true });
    if (!found.length) lines.push(row('found', 'none'));
    for (const entry of found) {
      lines.push(row(entry.path, `pid=${entry.pid} TERM_PROGRAM=${show(entry.term_program)} age=${entry.age_seconds}s`));
    }
  } catch (err) {
    lines.push(row('scan error', err.message));
  }
  lines.push('');

  lines.push('config');
  lines.push(row('enabled', String(cfg.enabled)));
  lines.push(row('cwd_source', cfg.cwd_source));
  lines.push(row('poll_ms', String(cfg.poll_ms)));
  lines.push(row('host', cfg.host));
  lines.push(row('log level', cfg.log_level));
  lines.push('');
  lines.push(`  this refresh: ${counters.frames}   log: ${log.logFile()}`);
  counters.frames += 1;
  return `${lines.join('\n')}\n`;
}

async function run(cfg) {
  const counters = { frames: 1, snapshotErrors: 0 };
  let stopping = false;

  const finish = () => {
    if (stopping) return;
    stopping = true;
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write('\u001b[?25h\n');
    process.exit(0);
  };

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.on('data', (chunk) => {
      if (chunk === 'q' || chunk === 'Q' || chunk === '\u0003' || chunk === '\u001b') finish();
    });
  }
  process.on('SIGINT', finish);
  process.on('SIGTERM', finish);

  process.stdout.write('\u001b[?25l\u001b[2J');
  while (!stopping) {
    const text = await frame(cfg, counters);
    process.stdout.write(`\u001b[H${text}\u001b[J`);
    await sleep(1000);
  }
  return 0;
}

module.exports = { run, frame };
