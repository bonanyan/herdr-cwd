'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const PANE = {
  pane_id: 'w1:p9',
  workspace_id: 'w1',
  tab_id: 'w1:t1',
  focused: true,
  cwd: '/tmp/logical',
  foreground_cwd: '/private/tmp/logical',
};

function fakeServer(responses) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-cwd-herdr-'));
  const socketPath = path.join(dir, 'herdr.sock');
  const seen = [];
  const server = net.createServer((conn) => {
    let buffer = '';
    conn.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const at = buffer.indexOf('\n');
      if (at < 0) return;
      const doc = JSON.parse(buffer.slice(0, at));
      seen.push(doc.method);
      const reply = responses[doc.method];
      if (!reply) {
        conn.end(`${JSON.stringify({ id: doc.id, error: { code: 'not_found', message: `no handler for ${doc.method}` } })}\n`);
        return;
      }
      conn.end(`${JSON.stringify({ id: doc.id, result: reply })}\n`);
    });
    conn.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(socketPath, () => resolve({ server, socketPath, dir, seen }));
  });
}

function withSocket(socketPath, fn) {
  const previous = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = socketPath;
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/lib/herdr.js') || key.includes('/lib/paths.js') || key.includes('/lib/socket.js')) delete require.cache[key];
  }
  const herdr = require('../lib/herdr');
  return Promise.resolve()
    .then(() => fn(herdr))
    .finally(() => {
      if (previous === undefined) delete process.env.HERDR_SOCKET_PATH;
      else process.env.HERDR_SOCKET_PATH = previous;
    });
}

test('pickCwd honours the configured source', () => {
  const herdr = require('../lib/herdr');
  assert.equal(herdr.pickCwd(PANE, 'auto'), '/private/tmp/logical');
  assert.equal(herdr.pickCwd(PANE, 'foreground_cwd'), '/private/tmp/logical');
  assert.equal(herdr.pickCwd(PANE, 'cwd'), '/tmp/logical');
  assert.equal(herdr.pickCwd({ cwd: '/tmp/only' }, 'auto'), '/tmp/only');
  assert.equal(herdr.pickCwd(null, 'auto'), '');
});

test('focusedPane reads the focused pane over the socket', async () => {
  const fake = await fakeServer({ 'pane.list': { type: 'pane_list', panes: [{ ...PANE, focused: false, pane_id: 'w1:p1' }, PANE] } });
  try {
    await withSocket(fake.socketPath, async (herdr) => {
      const info = await herdr.focusedPane({ transport: 'socket' });
      assert.equal(info.method, 'pane.list');
      assert.equal(info.transport, 'socket');
      assert.equal(info.pane.pane_id, 'w1:p9');
      assert.equal(info.pane_count, 2);
      assert.deepEqual(fake.seen, ['pane.list']);
    });
  } finally {
    fake.server.close();
    fs.rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('focusedPane falls back to session.snapshot when pane.list is unsupported', async () => {
  const fake = await fakeServer({
    'session.snapshot': {
      type: 'session_snapshot',
      snapshot: { focused_pane_id: 'w1:p9', panes: [{ ...PANE, focused: false, pane_id: 'w1:p1' }, PANE] },
    },
  });
  try {
    await withSocket(fake.socketPath, async (herdr) => {
      const info = await herdr.focusedPane({ transport: 'socket' });
      assert.equal(info.method, 'session.snapshot');
      assert.equal(info.pane.pane_id, 'w1:p9');
      assert.deepEqual(fake.seen, ['pane.list', 'session.snapshot']);
    });
  } finally {
    fake.server.close();
    fs.rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('chooseTransport picks the socket when it answers fast', async () => {
  const fake = await fakeServer({ 'pane.list': { type: 'pane_list', panes: [PANE] } });
  try {
    await withSocket(fake.socketPath, async (herdr) => {
      const choice = await herdr.chooseTransport({ transport: 'auto', socket_timeout_ms: 1000 }, { samples: 4, force: true });
      assert.equal(choice, 'socket');
      assert.match(herdr.transportHealth().auto.reason, /socket median/);
    });
  } finally {
    fake.server.close();
    fs.rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('chooseTransport falls back to the cli when the socket is missing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-cwd-nosock-'));
  const missing = path.join(dir, 'herdr.sock');
  try {
    await withSocket(missing, async (herdr) => {
      const choice = await herdr.chooseTransport({ transport: 'auto', socket_timeout_ms: 300 }, { samples: 3, force: true });
      assert.equal(choice, 'cli');
      assert.match(herdr.transportHealth().auto.reason, /socket probe failed/);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('chooseTransport respects an explicit transport', async () => {
  await withSocket('/tmp/herdr-cwd-irrelevant.sock', async (herdr) => {
    assert.equal(await herdr.chooseTransport({ transport: 'cli' }, { force: true }), 'cli');
    assert.equal(herdr.transportHealth().auto.reason, 'forced by config');
    assert.equal(await herdr.chooseTransport({ transport: 'socket' }, { force: true }), 'socket');
  });
});
