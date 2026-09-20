'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const socket = require('../lib/socket');

function tmpSocketPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-cwd-sock-')), 'herdr.sock');
}

function startServer(socketPath, handler) {
  return new Promise((resolve) => {
    const server = net.createServer((conn) => {
      let buffer = '';
      conn.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const at = buffer.indexOf('\n');
        if (at < 0) return;
        const doc = JSON.parse(buffer.slice(0, at));
        handler(conn, doc);
      });
      conn.on('error', () => {});
    });
    server.listen(socketPath, () => resolve(server));
  });
}

test('request sends one newline-delimited request and reads one response', async () => {
  const socketPath = tmpSocketPath();
  let seen = null;
  const server = await startServer(socketPath, (conn, doc) => {
    seen = doc;
    conn.end(`${JSON.stringify({ id: doc.id, result: { type: 'pong' } })}\n`);
  });
  try {
    const { result, rtt_ms } = await socket.request('ping', {}, { socketPath });
    assert.deepEqual(result, { type: 'pong' });
    assert.ok(rtt_ms >= 0);
    assert.equal(seen.method, 'ping');
    assert.deepEqual(seen.params, {});
    assert.ok(seen.id.length > 0);
  } finally {
    server.close();
    fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
  }
});

test('request reassembles a response delivered in chunks', async () => {
  const socketPath = tmpSocketPath();
  const server = await startServer(socketPath, (conn, doc) => {
    const body = `${JSON.stringify({ id: doc.id, result: { pane: { pane_id: 'w1:p1', foreground_cwd: '/tmp/x' } } })}\n`;
    const parts = [body.slice(0, 12), body.slice(12, 40), body.slice(40)];
    let i = 0;
    const push = () => {
      if (i >= parts.length) return;
      conn.write(parts[(i += 1) - 1]);
      setTimeout(push, 5);
    };
    push();
    setTimeout(() => conn.end(), 60);
  });
  try {
    const { result } = await socket.request('pane.current', {}, { socketPath, timeout: 2000 });
    assert.equal(result.pane.foreground_cwd, '/tmp/x');
  } finally {
    server.close();
    fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
  }
});

test('request ignores lines that carry a different id', async () => {
  const socketPath = tmpSocketPath();
  const server = await startServer(socketPath, (conn, doc) => {
    conn.write(`${JSON.stringify({ id: 'someone_else', result: { type: 'noise' } })}\n`);
    conn.end(`${JSON.stringify({ id: doc.id, result: { type: 'wanted' } })}\n`);
  });
  try {
    const { result } = await socket.request('ping', {}, { socketPath });
    assert.deepEqual(result, { type: 'wanted' });
  } finally {
    server.close();
    fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
  }
});

test('request surfaces herdr error responses', async () => {
  const socketPath = tmpSocketPath();
  const server = await startServer(socketPath, (conn, doc) => {
    conn.end(`${JSON.stringify({ id: doc.id, error: { code: 'not_found', message: 'pane not found' } })}\n`);
  });
  try {
    await assert.rejects(() => socket.request('pane.get', { pane_id: 'w1:nope' }, { socketPath }), (err) => {
      assert.equal(err.code, 'not_found');
      assert.match(err.message, /pane not found/);
      return true;
    });
  } finally {
    server.close();
    fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
  }
});

test('request times out when the server never answers', async () => {
  const socketPath = tmpSocketPath();
  const server = await startServer(socketPath, () => {});
  try {
    await assert.rejects(() => socket.request('ping', {}, { socketPath, timeout: 120 }), (err) => {
      assert.equal(err.code, 'ETIMEDOUT');
      return true;
    });
  } finally {
    server.close();
    fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
  }
});

test('request fails fast when the socket does not exist', async () => {
  await assert.rejects(() => socket.request('ping', {}, { socketPath: '/tmp/herdr-cwd-missing.sock' }), (err) => {
    assert.ok(['ENOENT', 'ECONNREFUSED'].includes(err.code), `unexpected code ${err.code}`);
    return true;
  });
});

test('request rejects when no socket path is configured', async () => {
  await assert.rejects(() => socket.request('ping', {}, {}), /no herdr socket path/);
});

test('available reports whether the path is a live socket', async () => {
  const socketPath = tmpSocketPath();
  const server = await startServer(socketPath, (conn) => conn.end());
  try {
    assert.equal(socket.available(socketPath), true);
    assert.equal(socket.available('/tmp/herdr-cwd-missing.sock'), false);
    assert.equal(socket.available(path.dirname(socketPath)), false);
  } finally {
    server.close();
    fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
  }
});
