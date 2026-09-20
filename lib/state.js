'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ensureDir, sessionKey, stateDir } = require('./paths');

function stateFile() {
  return path.join(ensureDir(stateDir()), `runtime-${sessionKey()}.json`);
}

function read() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function write(data) {
  try {
    fs.writeFileSync(stateFile(), `${JSON.stringify({ ...data, updated_at: new Date().toISOString() }, null, 2)}\n`);
  } catch {}
}

function clear() {
  try {
    fs.unlinkSync(stateFile());
  } catch {}
}

module.exports = { stateFile, read, write, clear };
