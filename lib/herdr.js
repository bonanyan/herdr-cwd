'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { herdrBin, socketPath } = require('./paths');

const execFileAsync = promisify(execFile);

async function runCli(args, { timeout = 6000 } = {}) {
  const { stdout } = await execFileAsync(herdrBin(), args, { timeout, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

function unwrap(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('empty response from herdr');
  if (doc.error) {
    const err = new Error(doc.error.message || 'herdr api error');
    err.code = doc.error.code;
    throw err;
  }
  return doc.result;
}

async function snapshot({ timeout = 6000 } = {}) {
  const stdout = await runCli(['api', 'snapshot'], { timeout });
  const result = unwrap(JSON.parse(stdout));
  return (result && result.snapshot) || null;
}

function focusedPane(snap) {
  if (!snap || !Array.isArray(snap.panes)) return null;
  return snap.panes.find((pane) => pane.pane_id === snap.focused_pane_id) || snap.panes.find((pane) => pane.focused) || null;
}

function paneCwd(pane, source = 'auto') {
  if (!pane) return '';
  const foreground = typeof pane.foreground_cwd === 'string' ? pane.foreground_cwd : '';
  const recorded = typeof pane.cwd === 'string' ? pane.cwd : '';
  if (source === 'foreground_cwd') return foreground;
  if (source === 'cwd') return recorded;
  return foreground || recorded;
}

async function status() {
  const stdout = await runCli(['status'], { timeout: 6000 });
  return stdout;
}

async function openPane(entrypoint) {
  const stdout = await runCli(['plugin', 'pane', 'open', '--plugin', 'herdr-cwd', '--entrypoint', entrypoint], { timeout: 10000 });
  return stdout;
}

module.exports = { runCli, snapshot, focusedPane, paneCwd, status, openPane, socketPath };
