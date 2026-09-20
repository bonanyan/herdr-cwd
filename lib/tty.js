'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');

const execFileAsync = promisify(execFile);

const SUBCOMMANDS = new Set([
  'api',
  'agent',
  'channel',
  'completion',
  'config',
  'help',
  'integration',
  'machine',
  'notification',
  'pane',
  'plugin',
  'server',
  'session',
  'status',
  'tab',
  'update',
  'worktree',
  'workspace',
]);

const VALUE_FLAGS = new Set([
  '--amount',
  '--agent',
  '--cwd',
  '--direction',
  '--entrypoint',
  '--format',
  '--label',
  '--limit',
  '--lines',
  '--machine',
  '--match',
  '--pane',
  '--plugin',
  '--ref',
  '--regex',
  '--remote',
  '--remote-session',
  '--session',
  '--socket',
  '--source',
  '--tab',
  '--timeout',
  '--until',
  '--workspace',
]);

function splitArgs(command) {
  const args = [];
  let current = '';
  let quote = null;
  for (const char of String(command)) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length) args.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.length) args.push(current);
  return args;
}

function isClientCommand(command) {
  const args = splitArgs(command);
  if (!args.length) return false;
  if (args[0].split('/').pop() !== 'herdr') return false;

  const positional = [];
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('-')) {
      if (VALUE_FLAGS.has(arg)) i += 1;
      continue;
    }
    positional.push(arg);
  }

  if (!positional.length) return true;
  if (positional[0] === 'session' && positional[1] === 'attach') return true;
  return !SUBCOMMANDS.has(positional[0]);
}

function etimeSeconds(value) {
  const parts = String(value === undefined ? '' : value).trim().split(/[-:]/);
  if (!parts.length || parts.some((part) => !/^\d+$/.test(part))) return 0;
  const nums = parts.map(Number);
  if (nums.length === 2) return nums[0] * 60 + nums[1];
  if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2];
  if (nums.length >= 4) return nums[0] * 86400 + nums[1] * 3600 + nums[2] * 60 + nums[3];
  return 0;
}

function parsePs(stdout) {
  const rows = [];
  for (const line of String(stdout).split('\n')) {
    const match = /^\s*(\S+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    rows.push({ tty: match[1], pid: Number(match[2]), etime: match[3], command: match[4].trim() });
  }
  return rows;
}

function isUsableTty(tty) {
  return Boolean(tty) && tty !== '??' && tty !== '-' && tty !== 'console';
}

function devicePath(tty) {
  if (tty.startsWith('/dev/')) return tty;
  return `/dev/${tty}`;
}

function isWritable(device) {
  try {
    fs.accessSync(device, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function psArgs() {
  const style = process.platform === 'darwin' ? '-ax' : '-e';
  return [style, '-o', 'tty=,pid=,etime=,command='];
}

async function readEnv(pid) {
  const cached = envCache.get(pid);
  if (cached) return cached;
  const { stdout } = await execFileAsync('ps', ['eww', '-p', String(pid)], { timeout: 4000, maxBuffer: 8 * 1024 * 1024 });
  const env = {};
  for (const token of String(stdout).split(/\s+/)) {
    const at = token.indexOf('=');
    if (at > 0) env[token.slice(0, at)] = token.slice(at + 1);
  }
  if (envCache.size > 256) envCache.clear();
  envCache.set(pid, env);
  return env;
}

async function scan(cfg) {
  let stdout = '';
  try {
    ({ stdout } = await execFileAsync('ps', psArgs(), { timeout: 5000, maxBuffer: 16 * 1024 * 1024 }));
  } catch {
    return [];
  }

  const candidates = parsePs(stdout).filter((row) => {
    if (!isUsableTty(row.tty)) return false;
    if (!isClientCommand(row.command)) return false;
    return etimeSeconds(row.etime) >= (cfg.min_client_age_seconds || 0);
  });

  const found = [];
  for (const row of candidates) {
    let env = {};
    try {
      env = await readEnv(row.pid);
    } catch {}
    if (cfg.skip_nested_clients && env.HERDR_PANE_ID) continue;
    const term = String(env.TERM_PROGRAM || '').toLowerCase();
    if (cfg.allow_term_programs.length && !cfg.allow_term_programs.includes(term)) continue;
    if (cfg.deny_term_programs.includes(term)) continue;
    const device = devicePath(row.tty);
    if (!isWritable(device)) continue;
    found.push({
      path: device,
      pid: row.pid,
      tty: row.tty,
      term_program: env.TERM_PROGRAM || '',
      term: env.TERM || '',
      age_seconds: etimeSeconds(row.etime),
    });
  }
  return found;
}

let cache = { at: 0, ttys: [] };
const envCache = new Map();

function invalidate() {
  cache = { at: 0, ttys: [] };
  envCache.clear();
}

async function discover(cfg, { force = false } = {}) {
  if (Array.isArray(cfg.ttys) && cfg.ttys.length) {
    return cfg.ttys
      .map((device) => ({ path: device, pid: null, tty: device, term_program: '', term: '', explicit: true }))
      .filter((entry) => isWritable(entry.path));
  }
  const now = Date.now();
  if (!force && cache.ttys.length && now - cache.at < cfg.tty_refresh_ms) return cache.ttys;
  const ttys = await scan(cfg);
  cache = { at: now, ttys };
  return ttys;
}

module.exports = {
  discover,
  invalidate,
  scan,
  parsePs,
  splitArgs,
  isClientCommand,
  etimeSeconds,
  devicePath,
  isUsableTty,
  readEnv,
};
