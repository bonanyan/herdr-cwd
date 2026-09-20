'use strict';

const fs = require('node:fs');

const UNRESERVED = /[A-Za-z0-9\-._~]/;
const EAGAIN_RETRIES = 20;
const EAGAIN_WAIT_MS = 2;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function percentEncode(value, keepSlash = false) {
  let out = '';
  for (const byte of Buffer.from(String(value), 'utf8')) {
    const char = String.fromCharCode(byte);
    if (UNRESERVED.test(char) || (keepSlash && char === '/')) {
      out += char;
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

function sequence(dir, host) {
  return `\u001b]7;file://${percentEncode(host)}${percentEncode(dir, true)}\u001b\\`;
}

function describe(dir, host) {
  const payload = sequence(dir, host);
  return {
    bytes: Buffer.byteLength(payload, 'utf8'),
    escaped: JSON.stringify(payload).slice(1, -1),
    uri: `file://${percentEncode(host)}${percentEncode(dir, true)}`,
  };
}

function write(device, payload) {
  const fd = fs.openSync(device, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
  const buffer = Buffer.from(payload, 'utf8');
  let offset = 0;
  try {
    let retries = 0;
    while (offset < buffer.length) {
      try {
        const written = fs.writeSync(fd, buffer, offset, buffer.length - offset);
        if (written <= 0) throw Object.assign(new Error('short write'), { code: 'EIO' });
        offset += written;
        retries = 0;
      } catch (err) {
        if (err.code !== 'EAGAIN' || ++retries > EAGAIN_RETRIES) throw err;
        sleepSync(EAGAIN_WAIT_MS);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return offset;
}

module.exports = { percentEncode, sequence, describe, write };
