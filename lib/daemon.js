'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const herdr = require('./herdr');
const lock = require('./lock');
const log = require('./log');
const osc7 = require('./osc7');
const paths = require('./paths');
const { pluginRoot } = paths;
const runtime = require('./state');
const tty = require('./tty');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function entrypoint() {
  return path.join(pluginRoot(), 'bin', 'herdr-cwd.js');
}

function spawnDaemon() {
  const child = spawn(process.execPath, [entrypoint(), 'daemon'], {
    detached: true,
    stdio: 'ignore',
    cwd: pluginRoot(),
    env: { ...process.env },
  });
  child.unref();
  return child.pid;
}

function ensure(cfg) {
  if (!cfg.enabled) return { started: false, pid: null, reason: 'disabled' };
  const existing = lock.readStatus();
  if (existing.alive) return { started: false, pid: existing.pid, reason: 'running' };
  const pid = spawnDaemon();
  return { started: true, pid, reason: 'spawned' };
}

function stop(timeoutMs = 3000) {
  const existing = lock.readStatus();
  if (!existing.alive) return Promise.resolve({ stopped: false, pid: null, reason: 'not running' });
  try {
    process.kill(existing.pid, 'SIGTERM');
  } catch (err) {
    return Promise.resolve({ stopped: false, pid: existing.pid, reason: err.message });
  }
  const deadline = Date.now() + timeoutMs;
  const wait = () =>
    new Promise((resolve) => {
      const check = () => {
        if (!lock.isAlive(existing.pid)) return resolve({ stopped: true, pid: existing.pid, reason: 'terminated' });
        if (Date.now() > deadline) return resolve({ stopped: false, pid: existing.pid, reason: 'still alive' });
        setTimeout(check, 100);
      };
      check();
    });
  return wait();
}

async function emitOnce(cfg, { devices = null } = {}) {
  const snap = await herdr.snapshot();
  const pane = herdr.focusedPane(snap);
  const cwd = herdr.paneCwd(pane, cfg.cwd_source);
  const targets = devices || (await tty.discover(cfg, { force: true }));
  const result = {
    cwd,
    pane_id: pane ? pane.pane_id : '',
    workspace_id: snap ? snap.focused_workspace_id || '' : '',
    tab_id: snap ? snap.focused_tab_id || '' : '',
    candidates: targets.map((entry) => entry.path),
    written: [],
    failed: [],
  };
  if (!cwd || !targets.length) return result;
  const payload = osc7.sequence(cwd, cfg.host);
  for (const target of targets) {
    try {
      osc7.write(target.path, payload);
      result.written.push(target.path);
    } catch (err) {
      result.failed.push({ path: target.path, error: err.code || err.message });
    }
  }
  return result;
}

async function run(cfg) {
  log.setLevel(cfg.log_level);
  if (!cfg.enabled) {
    log.info('daemon not started: disabled by config');
    runtime.write({ running: false, reason: 'disabled', pid: process.pid });
    return 0;
  }

  const acquired = lock.acquire();
  if (!acquired.acquired) {
    log.info('daemon already running', { pid: acquired.pid });
    return 0;
  }

  const startedAt = Date.now();
  const emitted = new Map();
  const counters = { polls: 0, writes: 0, errors: 0, lastWriteAt: '' };
  let consecutiveErrors = 0;
  let stopping = false;

  const publish = (extra) => {
    runtime.write({
      running: !stopping,
      pid: process.pid,
      started_at: new Date(startedAt).toISOString(),
      session_key: paths.sessionKey(),
      socket_path: paths.socketPath(),
      host: cfg.host,
      cwd_source: cfg.cwd_source,
      poll_ms: cfg.poll_ms,
      polls: counters.polls,
      writes: counters.writes,
      consecutive_errors: consecutiveErrors,
      ...extra,
    });
  };

  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    log.info('stopping', { signal });
    publish({});
    lock.release();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  log.info('daemon started', { pid: process.pid, poll_ms: cfg.poll_ms, cwd_source: cfg.cwd_source });
  publish({});

  for (;;) {
    if (stopping) break;
    let delay = cfg.poll_ms;
    counters.polls += 1;
    try {
      const snap = await herdr.snapshot();
      consecutiveErrors = 0;
      const pane = herdr.focusedPane(snap);
      const cwd = herdr.paneCwd(pane, cfg.cwd_source);
      const targets = await tty.discover(cfg);

      let written = 0;
      if (cwd && targets.length) {
        const payload = osc7.sequence(cwd, cfg.host);
        for (const target of targets) {
          if (emitted.get(target.path) === cwd) continue;
          try {
            osc7.write(target.path, payload);
            emitted.set(target.path, cwd);
            written += 1;
            counters.writes += 1;
          } catch (err) {
            emitted.delete(target.path);
            tty.invalidate();
            log.warn('tty write failed', { tty: target.path, error: err.code || err.message });
          }
        }
        const live = new Set(targets.map((entry) => entry.path));
        for (const key of [...emitted.keys()]) if (!live.has(key)) emitted.delete(key);
      }

      delay = targets.length ? cfg.poll_ms : cfg.idle_poll_ms;
      if (written) counters.lastWriteAt = new Date().toISOString();
      log.debug('tick', { cwd, pane_id: pane ? pane.pane_id : '', ttys: targets.length, written });
      publish({
        focused_pane_id: pane ? pane.pane_id : '',
        focused_workspace_id: (snap && snap.focused_workspace_id) || '',
        focused_tab_id: (snap && snap.focused_tab_id) || '',
        cwd: cwd || '',
        recorded_cwd: (pane && pane.cwd) || '',
        foreground_cwd: (pane && pane.foreground_cwd) || '',
        ttys: targets.map((entry) => ({ path: entry.path, term_program: entry.term_program, pid: entry.pid })),
        last_written: written,
        last_write_at: counters.lastWriteAt,
        last_error: '',
      });
    } catch (err) {
      consecutiveErrors += 1;
      counters.errors += 1;
      delay = cfg.idle_poll_ms;
      log.warn('poll failed', { consecutive_errors: consecutiveErrors, error: err.message });
      publish({ last_error: `${err.code ? `${err.code}: ` : ''}${err.message}` });
      if (consecutiveErrors >= cfg.max_consecutive_errors) {
        log.error('exiting after repeated failures', { consecutive_errors: consecutiveErrors });
        break;
      }
    }
    await sleep(delay);
  }

  stopping = true;
  publish({});
  lock.release();
  return 0;
}

module.exports = { run, ensure, stop, emitOnce, spawnDaemon, entrypoint };
