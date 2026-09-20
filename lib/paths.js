'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const PLUGIN_ID = 'herdr-cwd';

function xdg(kind, fallback) {
  const value = process.env[`XDG_${kind}_HOME`];
  return value && value.length ? value : fallback;
}

function configHome() {
  return xdg('CONFIG', path.join(os.homedir(), '.config'));
}

function stateHome() {
  return xdg('STATE', path.join(os.homedir(), '.local', 'state'));
}

function configDir() {
  if (process.env.HERDR_PLUGIN_CONFIG_DIR) return process.env.HERDR_PLUGIN_CONFIG_DIR;
  return path.join(configHome(), 'herdr', 'plugins', 'config', PLUGIN_ID);
}

function stateDir() {
  if (process.env.HERDR_PLUGIN_STATE_DIR) return process.env.HERDR_PLUGIN_STATE_DIR;
  return path.join(stateHome(), 'herdr', 'plugins', PLUGIN_ID);
}

function pluginRoot() {
  if (process.env.HERDR_PLUGIN_ROOT) return process.env.HERDR_PLUGIN_ROOT;
  return path.join(__dirname, '..');
}

function herdrBin() {
  return process.env.HERDR_BIN_PATH || 'herdr';
}

function socketPath() {
  if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH;
  const base = path.join(configHome(), 'herdr');
  const session = process.env.HERDR_SESSION;
  return session ? path.join(base, 'sessions', session, 'herdr.sock') : path.join(base, 'herdr.sock');
}

function sessionKey() {
  return crypto.createHash('sha1').update(socketPath()).digest('hex').slice(0, 12);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

module.exports = {
  PLUGIN_ID,
  configDir,
  stateDir,
  pluginRoot,
  herdrBin,
  socketPath,
  sessionKey,
  ensureDir,
};
