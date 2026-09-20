'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const shellDir = path.join(__dirname, '..', 'shell');

function available(bin) {
  const probe = spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  return probe.status === 0 && probe.stdout.trim().length > 0;
}

const CASES = [
  { file: 'hook.zsh', bin: 'zsh', flag: '-n' },
  { file: 'hook.bash', bin: 'bash', flag: '-n' },
  { file: 'hook.fish', bin: 'fish', flag: '-n' },
];

for (const entry of CASES) {
  test(`${entry.file} parses with ${entry.bin}`, { skip: available(entry.bin) ? false : `${entry.bin} not installed` }, () => {
    const file = path.join(shellDir, entry.file);
    assert.ok(fs.existsSync(file), `${file} is missing`);
    execFileSync(entry.bin, [entry.flag, file], { encoding: 'utf8' });
  });
}

test('the zsh hook is inert outside a herdr pane', () => {
  if (!available('zsh')) return;
  const out = execFileSync('zsh', ['-f', '-c', `
    unset HERDR_PANE_ID
    source ${path.join(shellDir, 'hook.zsh')}
    print -r -- "hooks=\${precmd_functions[*]}"
    print -r -- "root=\${_hcwd_root:-unset}"
  `], { encoding: 'utf8' });
  assert.match(out, /hooks=\s*$/m);
  assert.match(out, /root=unset/);
});

test('the zsh hook registers a precmd hook inside a herdr pane', () => {
  if (!available('zsh')) return;
  const out = execFileSync(
    'zsh',
    ['-f', '-c', `
      export HERDR_PANE_ID=w1:p1
      autoload -Uz add-zsh-hook
      source ${path.join(shellDir, 'hook.zsh')}
      print -r -- "hooks=\${precmd_functions[*]}"
      print -r -- "root=\${_hcwd_root}"
    `],
    { encoding: 'utf8', cwd: path.join(__dirname, '..') },
  );
  assert.match(out, /hooks=_hcwd_ensure/);
  assert.match(out, /root=.*herdr-cwd/);
});

test('the zsh hook does not spawn node while a daemon is alive', () => {
  if (!available('zsh')) return;
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'herdr-cwd-hook-'));
  try {
    const stateDir = path.join(root, 'herdr', 'plugins', 'herdr-cwd');
    fs.mkdirSync(stateDir, { recursive: true });
    const key = require('node:crypto').createHash('sha1').update('/tmp/herdr-cwd-hook.sock').digest('hex').slice(0, 12);
    fs.writeFileSync(path.join(stateDir, `daemon-${key}.pid`), String(process.pid));
    const out = execFileSync(
      'zsh',
      ['-f', '-c', `
        export HERDR_PANE_ID=w1:p1 XDG_STATE_HOME=${root} HERDR_SOCKET_PATH=/tmp/herdr-cwd-hook.sock
        autoload -Uz add-zsh-hook
        source ${path.join(shellDir, 'hook.zsh')}
        _hcwd_ensure
        print -r -- "pidfile=$_hcwd_pidfile"
      `],
      { encoding: 'utf8', cwd: path.join(__dirname, '..') },
    );
    assert.match(out, new RegExp(`pidfile=${stateDir}/daemon-${key}\\.pid`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
