#!/usr/bin/env node
'use strict';

const { loadConfig, writeTemplate } = require('../lib/config');
const daemon = require('../lib/daemon');
const doctor = require('../lib/doctor');
const herdr = require('../lib/herdr');
const lock = require('../lib/lock');
const log = require('../lib/log');
const monitor = require('../lib/monitor');
const paths = require('../lib/paths');
const runtime = require('../lib/state');
const tty = require('../lib/tty');
const pkg = require('../package.json');

const USAGE = `herdr-cwd ${pkg.version} - mirror the focused herdr pane's cwd to the host terminal (OSC 7)

Usage: herdr-cwd <command> [options]

Commands:
  start            Start the sync daemon if it is not running
  stop             Stop the sync daemon
  restart          Stop, then start the daemon with the current config
  status           Show daemon state, focused pane cwd, and discovered terminals
  emit             Write OSC 7 for the focused pane's cwd once, right now
  nudge            One-shot emit plus daemon watchdog (used by herdr event hooks)
  daemon           Run the sync loop in the foreground (used by "start")
  doctor           Full diagnostics report
  bench            Measure the herdr round-trip over the socket and the CLI
  monitor          Live popup view, refreshed once a second (q to quit)
  open-monitor     Open the monitor as a herdr popup pane
  open-doctor      Open the doctor report as a herdr popup pane
  config           Print the effective config
  config --init    Write a config.json template into the plugin config dir
  version          Print the plugin version
  help             Print this message

Options:
  --json           Machine-readable output
  --tty <device>   Target one terminal device instead of scanning (repeatable)
  --force          With "config --init", overwrite an existing config.json
  --quiet          Suppress normal output (for hooks)
`;

function parseArgv(argv) {
  const flags = { json: false, force: false, quiet: false, tty: [], positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') flags.json = true;
    else if (arg === '--force') flags.force = true;
    else if (arg === '--quiet' || arg === '-q') flags.quiet = true;
    else if (arg === '--help' || arg === '-h') flags.positional.push('help');
    else if (arg === '--version' || arg === '-V') flags.positional.push('version');
    else if (arg === '--tty') flags.tty.push(argv[(i += 1)]);
    else if (arg.startsWith('--tty=')) flags.tty.push(arg.slice('--tty='.length));
    else flags.positional.push(arg);
  }
  return flags;
}

function output(flags, text, data) {
  if (flags.quiet) return;
  if (flags.json) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function fail(flags, message, code = 1) {
  if (flags.json) process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
  else process.stderr.write(`herdr-cwd: ${message}\n`);
  process.exit(code);
}

function renderStatus(cfg, state, daemonState, snapshotInfo, terminals) {
  const lines = [];
  lines.push(`herdr-cwd: ${daemonState.alive ? `daemon running (pid ${daemonState.pid})` : 'daemon not running'}`);
  if (!cfg.enabled) lines.push('  note: disabled by config');
  lines.push(`  focused pane       ${show(snapshotInfo.pane_id)}`);
  lines.push(`  cwd                ${show(snapshotInfo.cwd)}`);
  if (snapshotInfo.foreground_cwd && snapshotInfo.foreground_cwd !== snapshotInfo.cwd) {
    lines.push(`  recorded cwd       ${show(snapshotInfo.recorded_cwd)}`);
  }
  lines.push(`  terminals          ${terminals.length ? terminals.map((t) => `${t.path}${t.term_program ? ` (${t.term_program})` : ''}`).join(', ') : 'none found'}`);
  if (snapshotInfo.transport) {
    lines.push(`  herdr call         ${snapshotInfo.method} via ${snapshotInfo.transport} in ${snapshotInfo.rtt_ms}ms (poll every ${cfg.poll_ms}ms)`);
  }
  if (state.rtt_avg_ms !== undefined) {
    lines.push(`  daemon latency     herdr rtt avg ${state.rtt_avg_ms}ms max ${state.rtt_max_ms}ms | tick->write avg ${state.reaction_avg_ms}ms max ${state.reaction_max_ms}ms`);
  }
  lines.push(`  polls / writes     ${show(state.polls, 0)} / ${show(state.writes, 0)}`);
  lines.push(`  last write         ${show(state.last_write_at, 'never')}`);
  if (state.last_error) lines.push(`  last error         ${state.last_error}`);
  lines.push(`  config             ${cfg.config_file}`);
  return lines.join('\n');
}

function show(value, fallback = '-') {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value);
}

async function gatherStatus(cfg) {
  const daemonState = lock.readStatus();
  const state = runtime.read() || {};
  let snapshotInfo = { pane_id: '', cwd: '', foreground_cwd: '', recorded_cwd: '', error: '' };
  try {
    const info = await herdr.focusedPane(cfg);
    const pane = info.pane;
    snapshotInfo = {
      pane_id: (pane && pane.pane_id) || '',
      cwd: herdr.pickCwd(pane, cfg.cwd_source),
      foreground_cwd: (pane && pane.foreground_cwd) || '',
      recorded_cwd: (pane && pane.cwd) || '',
      workspace_id: (pane && pane.workspace_id) || '',
      tab_id: (pane && pane.tab_id) || '',
      method: info.method,
      transport: info.transport,
      rtt_ms: +info.rtt_ms.toFixed(2),
    };
  } catch (err) {
    snapshotInfo.error = err.message;
  }
  let terminals = [];
  try {
    terminals = await tty.discover(cfg, { force: true });
  } catch {}
  return { daemonState, state, snapshotInfo, terminals };
}

async function openPluginPane(entrypoint, flags) {
  try {
    await herdr.openPane(entrypoint);
    output(flags, `opened herdr-cwd ${entrypoint} popup`, { ok: true, entrypoint });
    return 0;
  } catch (err) {
    return fail(flags, `could not open the ${entrypoint} popup: ${err.message}`);
  }
}

async function main() {
  const flags = parseArgv(process.argv.slice(2));
  const command = flags.positional[0] || 'help';
  const cfg = loadConfig();
  log.setLevel(flags.quiet ? 'off' : cfg.log_level);

  switch (command) {
    case 'help':
      process.stdout.write(USAGE);
      return 0;

    case 'version':
      output(flags, `herdr-cwd ${pkg.version}`, { plugin: pkg.version, node: process.version, herdr_socket: paths.socketPath() });
      return 0;

    case 'daemon':
      return daemon.run(cfg);

    case 'start': {
      const result = daemon.ensure(cfg);
      log.info('start requested', result);
      output(
        flags,
        result.reason === 'disabled'
          ? 'herdr-cwd: disabled by config (set enabled = true or unset HERDR_CWD_DISABLED)'
          : result.started
            ? `herdr-cwd: daemon started (pid ${result.pid})`
            : `herdr-cwd: daemon already running (pid ${result.pid})`,
        { ok: true, ...result },
      );
      return 0;
    }

    case 'stop': {
      const result = await daemon.stop();
      log.info('stop requested', result);
      output(flags, `herdr-cwd: ${result.reason}${result.pid ? ` (pid ${result.pid})` : ''}`, { ok: true, ...result });
      return result.stopped || result.reason === 'not running' ? 0 : 1;
    }

    case 'restart': {
      await daemon.stop();
      const result = daemon.ensure(cfg);
      output(flags, `herdr-cwd: restarted (pid ${result.pid || 'n/a'})`, { ok: true, ...result });
      return 0;
    }

    case 'status': {
      const info = await gatherStatus(cfg);
      output(
        flags,
        renderStatus(cfg, info.state, info.daemonState, info.snapshotInfo, info.terminals),
        { ok: true, config: cfg, ...info },
      );
      return 0;
    }

    case 'emit': {
      if (!cfg.enabled) return fail(flags, 'disabled by config');
      const devices = flags.tty.length ? flags.tty.map((device) => ({ path: device, term_program: '', pid: null })) : null;
      try {
        const result = await daemon.emitOnce(cfg, { devices });
        log.info('manual emit', result);
        const text = [
          `herdr-cwd: cwd ${result.cwd || '(none reported by herdr)'}`,
          `  pane     ${show(result.pane_id)}`,
          `  written  ${result.written.length ? result.written.join(', ') : 'nothing'}`,
          result.failed.length ? `  failed   ${result.failed.map((f) => `${f.path} (${f.error})`).join(', ')}` : null,
        ]
          .filter(Boolean)
          .join('\n');
        output(flags, text, { ok: true, ...result });
        return result.failed.length ? 1 : 0;
      } catch (err) {
        return fail(flags, err.message);
      }
    }

    case 'nudge': {
      try {
        if (cfg.enabled) {
          const result = await daemon.emitOnce(cfg);
          log.debug('nudge emit', { cwd: result.cwd, written: result.written.length });
        }
        daemon.ensure(cfg);
      } catch (err) {
        log.warn('nudge failed', { error: err.message });
      }
      if (!flags.quiet) output(flags, 'herdr-cwd: nudged', { ok: true });
      return 0;
    }

    case 'bench': {
      const samples = Number(flags.positional[1]) > 0 ? Number(flags.positional[1]) : 12;
      try {
        const result = await herdr.bench(cfg, samples);
        const text = ['herdr-cwd bench (pane.list round trip):']
          .concat(
            Object.entries(result).map(([name, entry]) =>
              entry.samples
                ? `  ${name.padEnd(8)} median ${entry.median_ms}ms  min ${entry.min_ms}ms  max ${entry.max_ms}ms  n=${entry.samples}`
                : `  ${name.padEnd(8)} unavailable${entry.error ? ` (${entry.error})` : ''}`,
            ),
          )
          .join('\n');
        output(flags, text, { ok: true, samples, ...result });
        return 0;
      } catch (err) {
        return fail(flags, err.message);
      }
    }

    case 'doctor': {
      const report = await doctor.collect(cfg);
      output(flags, doctor.render(report), report);
      return 0;
    }

    case 'monitor':
      return monitor.run(cfg);

    case 'open-monitor':
      return openPluginPane('monitor', flags);

    case 'open-doctor':
      return openPluginPane('doctor', flags);

    case 'config': {
      if (flags.positional.includes('--init') || flags.force) {
        const result = writeTemplate(flags.force);
        output(
          flags,
          result.written ? `herdr-cwd: wrote ${result.file}` : `herdr-cwd: ${result.file} already exists (pass --force to overwrite)`,
          { ok: result.written, ...result },
        );
        return result.written ? 0 : 1;
      }
      output(flags, JSON.stringify(cfg, null, 2), cfg);
      return 0;
    }

    default:
      process.stderr.write(`herdr-cwd: unknown command "${command}"\n\n${USAGE}`);
      return 2;
  }
}

main().then(
  (code) => process.exit(code || 0),
  (err) => {
    process.stderr.write(`herdr-cwd: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  },
);
