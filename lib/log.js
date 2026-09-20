'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ensureDir, stateDir } = require('./paths');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, off: 100 };
const MAX_BYTES = 256 * 1024;

let threshold = LEVELS.info;
let echo = false;
let cachedFile = null;

function logFile() {
  if (!cachedFile) cachedFile = path.join(ensureDir(stateDir()), 'herdr-cwd.log');
  return cachedFile;
}

function setLevel(name) {
  threshold = LEVELS[name] === undefined ? LEVELS.info : LEVELS[name];
}

function setEcho(value) {
  echo = !!value;
}

function rotate(file) {
  try {
    const stat = fs.statSync(file);
    if (stat.size <= MAX_BYTES) return;
    const body = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, body.slice(Math.floor(body.length / 2)));
  } catch {}
}

function record(level, message, fields) {
  if ((LEVELS[level] || LEVELS.info) < threshold) return;
  const suffix = fields === undefined ? '' : ` ${safeJson(fields)}`;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}${suffix}\n`;
  if (echo) process.stderr.write(line);
  try {
    const file = logFile();
    rotate(file);
    fs.appendFileSync(file, line);
  } catch {}
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function tail(lines = 20) {
  try {
    const body = fs.readFileSync(logFile(), 'utf8').replace(/\n+$/, '');
    if (!body.length) return [];
    return body.split('\n').slice(-lines);
  } catch {
    return [];
  }
}

module.exports = {
  logFile,
  setLevel,
  setEcho,
  tail,
  debug: (message, fields) => record('debug', message, fields),
  info: (message, fields) => record('info', message, fields),
  warn: (message, fields) => record('warn', message, fields),
  error: (message, fields) => record('error', message, fields),
};
