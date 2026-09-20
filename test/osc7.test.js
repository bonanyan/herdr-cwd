'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const osc7 = require('../lib/osc7');

test('percentEncode keeps unreserved characters', () => {
  assert.equal(osc7.percentEncode('plain-path_1.0~x'), 'plain-path_1.0~x');
});

test('percentEncode escapes spaces, percent signs, and reserved bytes', () => {
  assert.equal(osc7.percentEncode('/Users/a b', true), '/Users/a%20b');
  assert.equal(osc7.percentEncode('/tmp/100%', true), '/tmp/100%25');
  assert.equal(osc7.percentEncode('/tmp/a#b?c', true), '/tmp/a%23b%3Fc');
});

test('percentEncode escapes every utf-8 byte of non-ascii input', () => {
  assert.equal(osc7.percentEncode('/tmp/日本語', true), '/tmp/%E6%97%A5%E6%9C%AC%E8%AA%9E');
});

test('percentEncode keeps slashes only when asked', () => {
  assert.equal(osc7.percentEncode('/a/b', true), '/a/b');
  assert.equal(osc7.percentEncode('/a/b', false), '%2Fa%2Fb');
});

test('sequence is an OSC 7 file uri terminated by ST', () => {
  assert.equal(osc7.sequence('/Users/me/proj', 'host.local'), '\u001b]7;file://host.local/Users/me/proj\u001b\\');
});

test('sequence escapes spaces in the path and the host', () => {
  assert.equal(
    osc7.sequence('/Users/my project', 'my host'),
    '\u001b]7;file://my%20host/Users/my%20project\u001b\\',
  );
});

test('describe reports the uri, byte length, and escaped form', () => {
  const info = osc7.describe('/tmp/a b', 'h.local');
  assert.equal(info.uri, 'file://h.local/tmp/a%20b');
  assert.equal(info.bytes, Buffer.byteLength(osc7.sequence('/tmp/a b', 'h.local'), 'utf8'));
  assert.match(info.escaped, /^\\u001b\]7;file:\/\/h\.local\/tmp\/a%20b\\u001b\\\\$/);
});

test('write pushes the whole sequence and reports the byte count', () => {
  const target = path.join(os.tmpdir(), `herdr-cwd-write-${process.pid}.out`);
  const payload = osc7.sequence('/tmp/a b', 'h.local');
  try {
    fs.writeFileSync(target, '');
    assert.equal(osc7.write(target, payload), Buffer.byteLength(payload, 'utf8'));
    assert.equal(fs.readFileSync(target, 'utf8'), payload);
  } finally {
    fs.rmSync(target, { force: true });
  }
});

test('write surfaces errors for unusable devices', () => {
  assert.throws(() => osc7.write('/definitely/not/a/device', osc7.sequence('/tmp', 'h')));
});
