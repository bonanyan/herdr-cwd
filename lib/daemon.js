'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const herdr = require('./herdr');
const lock = require('./lock');
const log = require('./log');
const osc7 = require('./osc7');
const paths = require('./paths');
const runtime = require('./state');
const tty = require('./tty');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function entrypoint() {
  return path.join(paths.pluginRoot(), 'bin', 'herdr-cwd.js');
}

function spawnDaemon() {
  const child = spawn(process.execPath, [entrypoint(), 'daemon'], {
    detached: true,
    stdio: 'ignore',
    cwd: paths.pluginRoot(),
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
  return new Promise((resolve) => {
    const check = () => {
      if (!lock.isAlive(existing.pid)) return resolve({ stopped: true, pid: existing.pid, reason: 'terminated' });
      if (Date.now() > deadline) return resolve({ stopped: false, pid: existing.pid, reason: 'still alive' });
      setTimeout(check, 100);
    };
    check();
  });
}

async function writeCwd(cfg, cwd, targets, emitted) {
  const payload = osc7.sequence(cwd, cfg.host);
  const written = [];
  const failed = [];
  for (const target of targets) {
    if (emitted && emitted.get(target.path) === cwd) continue;
    try {
      osc7.write(target.path, payload);
      if (emitted) emitted.set(target.path, cwd);
      written.push(target.path);
    } catch (err) {
      if (emitted) emitted.delete(target.path);
      tty.invalidate();
      failed.push({ path: target.path, error: err.code || err.message });
    }
  }
  return { written, failed };
}

async function emitOnce(cfg, { devices = null } = {}) {
  const info = await herdr.focusedPane(cfg);
  const pane = info.pane;
  const cwd = herdr.pickCwd(pane, cfg.cwd_source);
  const targets = devices || (await tty.discover(cfg, { force: true }));
  const { written, failed } = cwd && targets.length ? await writeCwd(cfg, cwd, targets, null) : { written: [], failed: [] };
  return {
    cwd,
    pane_id: pane ? pane.pane_id : '',
    workspace_id: (pane && pane.workspace_id) || '',
    tab_id: (pane && pane.tab_id) || '',
    transport: info.transport,
    rtt_ms: +info.rtt_ms.toFixed(2),
    method: info.method,
    candidates: targets.map((entry) => entry.path),
    written,
    failed,
  };
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
  const counters = { polls: 0, writes: 0, errors: 0, lastWriteAt: '', rttSum: 0, rttMax: 0, reactionSum: 0, reactionMax: 0 };
  let consecutiveErrors = 0;
  let stopping = false;
  let lastPublish = 0;
  let lastPublished = '';
  let transportChoice = cfg.transport;
  let lastProbe = 0;

  const publish = (extra, force = false) => {
    const payload = {
      running: !stopping,
      pid: process.pid,
      started_at: new Date(startedAt).toISOString(),
      session_key: paths.sessionKey(),
      socket_path: paths.socketPath(),
      host: cfg.host,
      transport: cfg.transport,
      transport_active: transportChoice,
      transport_reason: herdr.transportHealth().auto.reason,
      cwd_source: cfg.cwd_source,
      poll_ms: cfg.poll_ms,
      polls: counters.polls,
      writes: counters.writes,
      consecutive_errors: consecutiveErrors,
      rtt_avg_ms: counters.polls ? +(counters.rttSum / counters.polls).toFixed(2) : 0,
      rtt_max_ms: +counters.rttMax.toFixed(2),
      reaction_avg_ms: counters.writes ? +(counters.reactionSum / counters.writes).toFixed(2) : 0,
      reaction_max_ms: +counters.reactionMax.toFixed(2),
      ...extra,
    };
    const signature = JSON.stringify([payload.cwd, payload.focused_pane_id, payload.ttys, payload.last_error, payload.running]);
    const now = Date.now();
    if (!force && signature === lastPublished && now - lastPublish < cfg.state_flush_ms) return;
    lastPublished = signature;
    lastPublish = now;
    runtime.write(payload);
  };

  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    log.info('stopping', { signal });
    publish({}, true);
    lock.release();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  log.info('daemon started', {
    pid: process.pid,
    poll_ms: cfg.poll_ms,
    transport: cfg.transport,
    cwd_source: cfg.cwd_source,
  });

  if (cfg.transport === 'auto') {
    transportChoice = await herdr.chooseTransport(cfg);
    const probe = herdr.transportHealth().auto;
    log.info('transport probed', { transport: transportChoice, reason: probe.reason, socket_ms: probe.socket_ms, cli_ms: probe.cli_ms });
  }
  lastProbe = Date.now();
  publish({}, true);

  for (;;) {
    if (stopping) break;
    const tickStart = process.hrtime.bigint();
    let delay = cfg.poll_ms;
    counters.polls += 1;
    try {
      if (cfg.transport === 'auto' && Date.now() - lastProbe > 60000) {
        lastProbe = Date.now();
        const next = await herdr.chooseTransport(cfg, { force: true });
        if (next !== transportChoice) {
          transportChoice = next;
          log.info('transport switched', { transport: next, reason: herdr.transportHealth().auto.reason });
        }
      }
      const info = await herdr.focusedPane(cfg);
      consecutiveErrors = 0;
      counters.rttSum += info.rtt_ms;
      if (info.rtt_ms > counters.rttMax) counters.rttMax = info.rtt_ms;

      const pane = info.pane;
      const cwd = herdr.pickCwd(pane, cfg.cwd_source);
      const targets = await tty.discover(cfg);

      let written = 0;
      if (cwd && targets.length) {
        const outcome = await writeCwd(cfg, cwd, targets, emitted);
        written = outcome.written.length;
        if (written) {
          const reaction = Number(process.hrtime.bigint() - tickStart) / 1e6;
          counters.writes += written;
          counters.reactionSum += reaction;
          if (reaction > counters.reactionMax) counters.reactionMax = reaction;
          counters.lastWriteAt = new Date().toISOString();
        }
        for (const failure of outcome.failed) log.warn('tty write failed', failure);
        const live = new Set(targets.map((entry) => entry.path));
        for (const key of [...emitted.keys()]) if (!live.has(key)) emitted.delete(key);
      }

      delay = targets.length ? cfg.poll_ms : cfg.idle_poll_ms;
      log.debug('tick', {
        cwd,
        pane_id: pane ? pane.pane_id : '',
        transport: info.transport,
        rtt_ms: +info.rtt_ms.toFixed(2),
        ttys: targets.length,
        written,
      });
      publish({
        focused_pane_id: pane ? pane.pane_id : '',
        focused_workspace_id: (pane && pane.workspace_id) || '',
        focused_tab_id: (pane && pane.tab_id) || '',
        cwd: cwd || '',
        recorded_cwd: (pane && pane.cwd) || '',
        foreground_cwd: (pane && pane.foreground_cwd) || '',
        active_transport: info.transport,
        active_method: info.method,
        ttys: targets.map((entry) => ({ path: entry.path, term_program: entry.term_program, pid: entry.pid })),
        last_written: written,
        last_write_at: counters.lastWriteAt,
        last_error: '',
      }, written > 0);
    } catch (err) {
      consecutiveErrors += 1;
      counters.errors += 1;
      delay = consecutiveErrors > 12 ? Math.max(cfg.idle_poll_ms, 10000) : cfg.idle_poll_ms;
      log.warn('poll failed', { consecutive_errors: consecutiveErrors, error: err.message });
      publish({ last_error: `${err.code ? `${err.code}: ` : ''}${err.message}` }, true);
      if (cfg.max_consecutive_errors > 0 && consecutiveErrors >= cfg.max_consecutive_errors) {
        log.error('exiting after repeated failures', { consecutive_errors: consecutiveErrors });
        break;
      }
    }
    await sleep(delay);
  }

  stopping = true;
  publish({}, true);
  lock.release();
  return 0;
}

module.exports = { run, ensure, stop, emitOnce, writeCwd, spawnDaemon, entrypoint };
