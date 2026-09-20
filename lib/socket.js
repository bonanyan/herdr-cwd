'use strict';

const net = require('node:net');
const fs = require('node:fs');

function available(socketPath) {
  try {
    return fs.statSync(socketPath).isSocket();
  } catch {
    return false;
  }
}

function request(method, params = {}, options = {}) {
  const { socketPath, timeout = 2000, id = `hcwd_${process.pid}_${Date.now()}` } = options;
  return new Promise((resolve, reject) => {
    if (!socketPath) {
      reject(Object.assign(new Error('no herdr socket path'), { code: 'ENOENT' }));
      return;
    }
    const started = process.hrtime.bigint();
    const socket = net.createConnection(socketPath);
    let buffer = '';
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners('data');
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      finish(Object.assign(new Error(`timeout after ${timeout}ms waiting for ${method}`), { code: 'ETIMEDOUT' }));
    }, timeout);

    socket.once('error', (err) => finish(err));
    socket.once('close', () => {
      if (!settled) finish(Object.assign(new Error('connection closed before a response'), { code: 'ECLOSED' }));
    });
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ id, method, params })}\n`, (err) => {
        if (err) finish(err);
      });
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line) continue;
        let doc;
        try {
          doc = JSON.parse(line);
        } catch {
          continue;
        }
        if (doc.id !== undefined && doc.id !== id) continue;
        if (doc.error) {
          const err = new Error(doc.error.message || `herdr api error for ${method}`);
          err.code = doc.error.code;
          err.api = true;
          finish(err);
          return;
        }
        finish(null, { result: doc.result, rtt_ms: Number(process.hrtime.bigint() - started) / 1e6 });
        return;
      }
    });
  });
}

module.exports = { request, available };
