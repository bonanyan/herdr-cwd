'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function withConfigDir(contents, env, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-cwd-test-'));
  const previousDir = process.env.HERDR_PLUGIN_CONFIG_DIR;
  const savedEnv = {};
  process.env.HERDR_PLUGIN_CONFIG_DIR = dir;
  for (const [key, value] of Object.entries(env)) {
    savedEnv[key] = process.env[key];
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    if (contents) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(contents));
    delete require.cache[require.resolve('../lib/config')];
    delete require.cache[require.resolve('../lib/paths')];
    const { loadConfig } = require('../lib/config');
    return fn(loadConfig(), dir);
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (previousDir === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    else process.env.HERDR_PLUGIN_CONFIG_DIR = previousDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('falls back to defaults when there is no config file', () => {
  withConfigDir(null, {}, (cfg) => {
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.transport, 'auto');
    assert.equal(cfg.poll_ms, 100);
    assert.equal(cfg.idle_poll_ms, 2000);
    assert.equal(cfg.socket_timeout_ms, 2000);
    assert.equal(cfg.cwd_source, 'auto');
    assert.equal(cfg.log_level, 'info');
    assert.equal(cfg.max_consecutive_errors, 0);
    assert.equal(cfg.min_client_age_seconds, 1);
    assert.ok(cfg.host.length > 0);
    assert.deepEqual(cfg.ttys, []);
  });
});

test('normalizes values from the config file', () => {
  withConfigDir(
    { poll_ms: '1200', cwd_source: 'nonsense', log_level: 'debug', ttys: '/dev/ttys001, /dev/ttys002', allow_term_programs: ['Otty'] },
    {},
    (cfg) => {
      assert.equal(cfg.poll_ms, 1200);
      assert.equal(cfg.cwd_source, 'auto');
      assert.equal(cfg.log_level, 'debug');
      assert.deepEqual(cfg.ttys, ['/dev/ttys001', '/dev/ttys002']);
      assert.deepEqual(cfg.allow_term_programs, ['otty']);
    },
  );
});

test('environment variables win over the config file', () => {
  withConfigDir(
    { poll_ms: 1000 },
    { HERDR_CWD_POLL_MS: '2500', HERDR_CWD_DISABLED: '1', HERDR_CWD_TTY: '/dev/ttys009', HERDR_CWD_SOURCE: 'cwd' },
    (cfg) => {
      assert.equal(cfg.poll_ms, 2500);
      assert.equal(cfg.enabled, false);
      assert.deepEqual(cfg.ttys, ['/dev/ttys009']);
      assert.equal(cfg.cwd_source, 'cwd');
    },
  );
});

test('idle polling never gets faster than active polling', () => {
  withConfigDir({ poll_ms: 4000, idle_poll_ms: 1000 }, {}, (cfg) => {
    assert.equal(cfg.idle_poll_ms, 4000);
  });
});

test('clamps out-of-range numbers', () => {
  withConfigDir({ poll_ms: 1, idle_poll_ms: 999999999, socket_timeout_ms: 1 }, {}, (cfg) => {
    assert.equal(cfg.poll_ms, 20);
    assert.equal(cfg.idle_poll_ms, 600000);
    assert.equal(cfg.socket_timeout_ms, 100);
  });
});

test('transport accepts only known values', () => {
  withConfigDir({ transport: 'carrier-pigeon' }, {}, (cfg) => assert.equal(cfg.transport, 'auto'));
  withConfigDir({ transport: 'cli' }, {}, (cfg) => assert.equal(cfg.transport, 'cli'));
  withConfigDir({ transport: 'auto' }, { HERDR_CWD_TRANSPORT: 'socket' }, (cfg) => assert.equal(cfg.transport, 'socket'));
  withConfigDir(null, { HERDR_CWD_TRANSPORT: 'nonsense' }, (cfg) => assert.equal(cfg.transport, 'auto'));
});
