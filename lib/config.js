'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { configDir } = require('./paths');

const DEFAULTS = {
  enabled: true,
  transport: 'auto',
  poll_ms: 100,
  idle_poll_ms: 2000,
  socket_timeout_ms: 2000,
  state_flush_ms: 1000,
  tty_refresh_ms: 2000,
  max_consecutive_errors: 0,
  cwd_source: 'auto',
  host: '',
  ttys: [],
  allow_term_programs: [],
  deny_term_programs: [],
  skip_nested_clients: true,
  min_client_age_seconds: 1,
  log_level: 'info',
};

const CWD_SOURCES = new Set(['auto', 'foreground_cwd', 'cwd']);
const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error', 'off']);
const TRANSPORTS = new Set(['auto', 'socket', 'cli']);

function configFile() {
  return path.join(configDir(), 'config.json');
}

function number(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function stringList(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/[:,]/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function boolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return fallback;
  return !/^(0|false|no|off)$/i.test(String(value));
}

function readJsonFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function template() {
  return { ...DEFAULTS, host: '', comment: 'Delete any key to keep its default. See README.md for what each one does.' };
}

function writeTemplate(force = false) {
  const file = configFile();
  if (!force && fs.existsSync(file)) return { written: false, file };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(template(), null, 2)}\n`);
  return { written: true, file };
}

function loadConfig(overrides = {}) {
  const file = configFile();
  const raw = { ...DEFAULTS, ...readJsonFile(file), ...overrides };
  const env = process.env;

  const cfg = {
    config_file: file,
    enabled: boolean(raw.enabled, DEFAULTS.enabled),
    transport: TRANSPORTS.has(String(raw.transport)) ? String(raw.transport) : DEFAULTS.transport,
    poll_ms: number(raw.poll_ms, DEFAULTS.poll_ms, 20, 60000),
    idle_poll_ms: number(raw.idle_poll_ms, DEFAULTS.idle_poll_ms, 200, 600000),
    socket_timeout_ms: number(raw.socket_timeout_ms, DEFAULTS.socket_timeout_ms, 100, 60000),
    state_flush_ms: number(raw.state_flush_ms, DEFAULTS.state_flush_ms, 100, 60000),
    tty_refresh_ms: number(raw.tty_refresh_ms, DEFAULTS.tty_refresh_ms, 250, 600000),
    max_consecutive_errors: number(raw.max_consecutive_errors, DEFAULTS.max_consecutive_errors, 0, 100000),
    cwd_source: CWD_SOURCES.has(raw.cwd_source) ? raw.cwd_source : DEFAULTS.cwd_source,
    host: typeof raw.host === 'string' && raw.host.trim().length ? raw.host.trim() : os.hostname(),
    ttys: stringList(raw.ttys),
    allow_term_programs: stringList(raw.allow_term_programs).map((item) => item.toLowerCase()),
    deny_term_programs: stringList(raw.deny_term_programs).map((item) => item.toLowerCase()),
    skip_nested_clients: boolean(raw.skip_nested_clients, DEFAULTS.skip_nested_clients),
    min_client_age_seconds: number(raw.min_client_age_seconds, DEFAULTS.min_client_age_seconds, 0, 3600),
    log_level: LOG_LEVELS.has(String(raw.log_level)) ? String(raw.log_level) : DEFAULTS.log_level,
  };

  if (boolean(env.HERDR_CWD_DISABLED, false)) cfg.enabled = false;
  if (env.HERDR_CWD_ENABLED !== undefined) cfg.enabled = boolean(env.HERDR_CWD_ENABLED, cfg.enabled);
  if (env.HERDR_CWD_TRANSPORT && TRANSPORTS.has(env.HERDR_CWD_TRANSPORT)) cfg.transport = env.HERDR_CWD_TRANSPORT;
  if (env.HERDR_CWD_POLL_MS) cfg.poll_ms = number(env.HERDR_CWD_POLL_MS, cfg.poll_ms, 20, 60000);
  if (env.HERDR_CWD_IDLE_POLL_MS) cfg.idle_poll_ms = number(env.HERDR_CWD_IDLE_POLL_MS, cfg.idle_poll_ms, 200, 600000);
  if (env.HERDR_CWD_SOCKET_TIMEOUT_MS) cfg.socket_timeout_ms = number(env.HERDR_CWD_SOCKET_TIMEOUT_MS, cfg.socket_timeout_ms, 100, 60000);
  if (env.HERDR_CWD_SOURCE && CWD_SOURCES.has(env.HERDR_CWD_SOURCE)) cfg.cwd_source = env.HERDR_CWD_SOURCE;
  if (env.HERDR_CWD_HOST) cfg.host = env.HERDR_CWD_HOST;
  if (env.HERDR_CWD_TTY) cfg.ttys = stringList(env.HERDR_CWD_TTY);
  if (env.HERDR_CWD_TERM_PROGRAMS) cfg.allow_term_programs = stringList(env.HERDR_CWD_TERM_PROGRAMS).map((i) => i.toLowerCase());
  if (env.HERDR_CWD_LOG_LEVEL && LOG_LEVELS.has(env.HERDR_CWD_LOG_LEVEL)) cfg.log_level = env.HERDR_CWD_LOG_LEVEL;

  if (cfg.idle_poll_ms < cfg.poll_ms) cfg.idle_poll_ms = cfg.poll_ms;
  return cfg;
}

module.exports = { DEFAULTS, loadConfig, configFile, template, writeTemplate };
