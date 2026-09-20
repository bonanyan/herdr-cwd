'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const socket = require('./socket');
const { herdrBin, socketPath } = require('./paths');

const execFileAsync = promisify(execFile);

const CLI_FALLBACKS = {
  'pane.current': ['pane', 'current'],
  'pane.list': ['pane', 'list'],
  'pane.process_info': ['pane', 'process_info'],
  'session.snapshot': ['api', 'snapshot'],
};

const SOCKET_RETRY_MS = 5000;
const SOCKET_FAST_MS = 20;
const health = { ok: true, failures: 0, failed_at: 0, last_error: '', last_transport: '', last_rtt_ms: 0, calls: 0 };
const auto = { choice: 'cli', decided_at: 0, reason: 'not probed yet', socket_ms: null, cli_ms: null };

function transportHealth() {
  return { ...health, auto: { ...auto } };
}

function resetHealth() {
  health.ok = true;
  health.failures = 0;
  health.failed_at = 0;
  health.last_error = '';
}

function autoChoice() {
  return auto.choice;
}

function setAutoChoice(choice, reason, socket_ms, cli_ms) {
  auto.choice = choice;
  auto.reason = reason;
  auto.socket_ms = socket_ms;
  auto.cli_ms = cli_ms;
  auto.decided_at = Date.now();
}

async function runCli(args, { timeout = 6000 } = {}) {
  const { stdout } = await execFileAsync(herdrBin(), args, { timeout, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

function unwrap(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('empty response from herdr');
  if (doc.error) {
    const err = new Error(doc.error.message || 'herdr api error');
    err.code = doc.error.code;
    err.api = true;
    throw err;
  }
  return doc.result;
}

function socketUsable(cfg) {
  const choice = cfg.transport === 'auto' ? auto.choice : cfg.transport;
  if (choice === 'cli') return false;
  if (choice === 'socket') return true;
  if (health.ok) return true;
  return Date.now() - health.failed_at > SOCKET_RETRY_MS;
}

async function call(method, params = {}, cfg = {}) {
  health.calls += 1;
  const timeout = cfg.socket_timeout_ms || 2000;
  if (socketUsable(cfg)) {
    const path = socketPath();
    if (cfg.transport === 'socket' || auto.choice === 'socket' || socket.available(path)) {
      try {
        const { result, rtt_ms } = await socket.request(method, params, { socketPath: path, timeout });
        health.ok = true;
        health.failures = 0;
        health.last_error = '';
        health.last_transport = 'socket';
        health.last_rtt_ms = rtt_ms;
        return { result, transport: 'socket', rtt_ms };
      } catch (err) {
        if (err.api) throw err;
        health.ok = false;
        health.failures += 1;
        health.failed_at = Date.now();
        health.last_error = `${err.code ? `${err.code}: ` : ''}${err.message}`;
        if (cfg.transport === 'socket') throw err;
      }
    }
  }

  const args = CLI_FALLBACKS[method];
  if (!args) throw new Error(`no CLI fallback for ${method}`);
  const started = process.hrtime.bigint();
  const stdout = await runCli(args, { timeout: Math.max(timeout, 6000) });
  const rtt_ms = Number(process.hrtime.bigint() - started) / 1e6;
  health.last_transport = 'cli';
  health.last_rtt_ms = rtt_ms;
  return { result: unwrap(JSON.parse(stdout)), transport: 'cli', rtt_ms };
}

async function focusedPane(cfg = {}) {
  try {
    const { result, transport, rtt_ms } = await call('pane.list', {}, cfg);
    const panes = (result && result.panes) || [];
    const pane = panes.find((entry) => entry.focused) || null;
    if (panes.length) return { pane, transport, rtt_ms, method: 'pane.list', pane_count: panes.length };
  } catch {}
  const { result, transport, rtt_ms } = await call('session.snapshot', {}, cfg);
  const snap = (result && result.snapshot) || {};
  const panes = Array.isArray(snap.panes) ? snap.panes : [];
  const pane = panes.find((entry) => entry.pane_id === snap.focused_pane_id) || panes.find((entry) => entry.focused) || null;
  return { pane, transport, rtt_ms, method: 'session.snapshot', pane_count: panes.length };
}

async function paneList(cfg = {}) {
  const { result, transport, rtt_ms } = await call('pane.list', {}, cfg);
  return { panes: (result && result.panes) || [], transport, rtt_ms };
}

async function snapshot(cfg = {}) {
  const { result, transport, rtt_ms } = await call('session.snapshot', {}, cfg);
  return { snapshot: (result && result.snapshot) || null, transport, rtt_ms };
}

function pickCwd(pane, source = 'auto') {
  if (!pane) return '';
  const foreground = typeof pane.foreground_cwd === 'string' ? pane.foreground_cwd : '';
  const recorded = typeof pane.cwd === 'string' ? pane.cwd : '';
  if (source === 'foreground_cwd') return foreground;
  if (source === 'cwd') return recorded;
  return foreground || recorded;
}

async function serverStatus() {
  return runCli(['status'], { timeout: 6000 });
}

async function openPane(entrypoint) {
  return runCli(['plugin', 'pane', 'open', '--plugin', 'herdr-cwd', '--entrypoint', entrypoint], { timeout: 10000 });
}

async function bench(cfg = {}, samples = 12) {
  const out = {};
  for (const transport of ['socket', 'cli']) {
    const probe = { ...cfg, transport };
    const rtts = [];
    let error = '';
    for (let i = 0; i < samples; i += 1) {
      try {
        const { rtt_ms } = await call('pane.list', {}, probe);
        rtts.push(rtt_ms);
      } catch (err) {
        error = err.message;
        break;
      }
    }
    const warm = rtts.slice(Math.min(2, Math.floor(rtts.length / 2)));
    out[transport] = warm.length
      ? {
          samples: warm.length,
          min_ms: +Math.min(...warm).toFixed(2),
          median_ms: +[...warm].sort((a, b) => a - b)[Math.floor(warm.length / 2)].toFixed(2),
          max_ms: +Math.max(...warm).toFixed(2),
          error,
        }
      : { samples: 0, error };
  }
  resetHealth();
  return out;
}

async function chooseTransport(cfg = {}, { samples = 5, force = false } = {}) {
  if (cfg.transport !== 'auto') {
    setAutoChoice(cfg.transport, 'forced by config', null, null);
    return auto.choice;
  }
  if (!force && auto.decided_at && Date.now() - auto.decided_at < 60000) return auto.choice;

  let result;
  try {
    result = await bench(cfg, samples);
  } catch (err) {
    setAutoChoice('cli', `probe failed: ${err.message}`, null, null);
    return auto.choice;
  }
  const socketMs = result.socket && result.socket.samples ? result.socket.median_ms : null;
  const cliMs = result.cli && result.cli.samples ? result.cli.median_ms : null;
  if (socketMs !== null && socketMs <= SOCKET_FAST_MS) {
    setAutoChoice('socket', `socket median ${socketMs}ms`, socketMs, cliMs);
  } else if (socketMs === null) {
    setAutoChoice('cli', `socket probe failed (${(result.socket && result.socket.error) || 'no samples'})`, socketMs, cliMs);
  } else {
    setAutoChoice('cli', `socket median ${socketMs}ms is above the ${SOCKET_FAST_MS}ms fast threshold`, socketMs, cliMs);
  }
  return auto.choice;
}

module.exports = {
  call,
  focusedPane,
  paneList,
  snapshot,
  pickCwd,
  serverStatus,
  openPane,
  bench,
  chooseTransport,
  autoChoice,
  transportHealth,
  resetHealth,
  socketPath,
  SOCKET_FAST_MS,
};
