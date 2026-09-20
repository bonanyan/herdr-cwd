'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const WATCHDOG = path.join(__dirname, '..', 'bin', 'watchdog.sh');

function socketKey(socket) {
  return crypto.createHash('sha1').update(socket).digest('hex').slice(0, 12);
}

function deadPid() {
  const result = spawnSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' });
  return Number(result.stdout.trim());
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-cwd-watchdog-'));
  const pluginRoot = path.join(root, 'plugin');
  const stateDir = path.join(root, 'state');
  const marker = path.join(root, 'started.marker');
  fs.mkdirSync(path.join(pluginRoot, 'bin'), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, 'bin', 'herdr-cwd.js'),
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');\n`,
  );
  return { root, pluginRoot, stateDir, marker };
}

function runWatchdog(f, socket) {
  execFileSync('sh', [WATCHDOG], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HERDR_PLUGIN_ROOT: f.pluginRoot,
      HERDR_PLUGIN_STATE_DIR: f.stateDir,
      HERDR_SOCKET_PATH: socket,
    },
  });
}

function pidfile(f, socket) {
  return path.join(f.stateDir, `daemon-${socketKey(socket)}.pid`);
}

test('watchdog.sh is a valid posix shell script', () => {
  execFileSync('sh', ['-n', WATCHDOG]);
});

test('exits quietly when this socket already has a live daemon', () => {
  const f = fixture();
  const socket = '/tmp/herdr-cwd-test-a.sock';
  try {
    fs.writeFileSync(pidfile(f, socket), String(process.pid));
    runWatchdog(f, socket);
    assert.equal(fs.existsSync(f.marker), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('starts a daemon when the pidfile holds a dead pid', () => {
  const f = fixture();
  const socket = '/tmp/herdr-cwd-test-b.sock';
  try {
    fs.writeFileSync(pidfile(f, socket), String(deadPid()));
    runWatchdog(f, socket);
    assert.equal(fs.readFileSync(f.marker, 'utf8'), 'started');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('starts a daemon when there is no pidfile at all', () => {
  const f = fixture();
  try {
    runWatchdog(f, '/tmp/herdr-cwd-test-c.sock');
    assert.equal(fs.readFileSync(f.marker, 'utf8'), 'started');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('ignores a live daemon that belongs to another socket', () => {
  const f = fixture();
  const socket = '/tmp/herdr-cwd-test-d.sock';
  try {
    fs.writeFileSync(pidfile(f, '/tmp/herdr-cwd-other-session.sock'), String(process.pid));
    runWatchdog(f, socket);
    assert.equal(fs.readFileSync(f.marker, 'utf8'), 'started');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('falls back to any live pidfile when no sha1 tool exists', () => {
  const f = fixture();
  const bin = path.join(f.root, 'bin');
  try {
    fs.mkdirSync(bin, { recursive: true });
    fs.symlinkSync('/bin/cat', path.join(bin, 'cat'));
    fs.symlinkSync('/usr/bin/cut', path.join(bin, 'cut'));
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    fs.writeFileSync(path.join(f.stateDir, 'daemon-ffffffffffff.pid'), String(process.pid));
    execFileSync('/bin/sh', [WATCHDOG], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HERDR_PLUGIN_ROOT: f.pluginRoot,
        HERDR_PLUGIN_STATE_DIR: f.stateDir,
        HERDR_SOCKET_PATH: '/tmp/herdr-cwd-test-e.sock',
        PATH: bin,
      },
    });
    assert.equal(fs.existsSync(f.marker), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
