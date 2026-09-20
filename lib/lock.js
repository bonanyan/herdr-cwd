'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ensureDir, sessionKey, stateDir } = require('./paths');

function lockFile() {
  return path.join(ensureDir(stateDir()), `daemon-${sessionKey()}.pid`);
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function readPid() {
  try {
    const pid = Number(fs.readFileSync(lockFile(), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function readStatus() {
  const pid = readPid();
  if (!pid) return { pid: null, alive: false };
  return { pid, alive: isAlive(pid) };
}

function acquire() {
  const existing = readPid();
  if (existing && existing !== process.pid && isAlive(existing)) return { acquired: false, pid: existing };
  fs.writeFileSync(lockFile(), String(process.pid));
  return { acquired: true, pid: process.pid };
}

function release() {
  if (readPid() !== process.pid) return false;
  try {
    fs.unlinkSync(lockFile());
    return true;
  } catch {
    return false;
  }
}

module.exports = { lockFile, readPid, readStatus, isAlive, acquire, release };
