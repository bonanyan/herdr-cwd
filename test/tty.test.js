'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tty = require('../lib/tty');

const PS_SAMPLE = `ttys004 43016 03:21:11 herdr
??       3333 05:12:33 /opt/homebrew/bin/herdr server
ttys007 40702 01:02:03 /Users/me/.config/herdr/plugins/herdr-sidebar
pts/3     1234    05:00 herdr --session work
ttys009   2222    00:01 herdr pane list --workspace w1
`;

test('parsePs reads tty, pid, etime, and command', () => {
  const rows = tty.parsePs(PS_SAMPLE);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0], { tty: 'ttys004', pid: 43016, etime: '03:21:11', command: 'herdr' });
  assert.equal(rows[3].tty, 'pts/3');
  assert.equal(rows[4].command, 'herdr pane list --workspace w1');
});

test('parsePs ignores malformed lines', () => {
  assert.deepEqual(tty.parsePs(''), []);
  assert.deepEqual(tty.parsePs('TTY PID ELTIME COMMAND'), []);
});

test('splitArgs honours quotes', () => {
  assert.deepEqual(tty.splitArgs('herdr --session "my work"'), ['herdr', '--session', 'my work']);
  assert.deepEqual(tty.splitArgs("herdr 'pane' list"), ['herdr', 'pane', 'list']);
});

test('isClientCommand accepts attach clients', () => {
  for (const command of [
    'herdr',
    '/opt/homebrew/bin/herdr',
    'herdr --session work',
    'herdr session attach work',
    'herdr --remote host',
    'herdr --machine prod',
  ]) {
    assert.equal(tty.isClientCommand(command), true, command);
  }
});

test('isClientCommand rejects the server, CLI calls, and lookalikes', () => {
  for (const command of [
    '/opt/homebrew/bin/herdr server',
    'herdr server',
    'herdr status',
    'herdr update',
    'herdr api snapshot',
    'herdr pane list --workspace w1',
    'herdr session list',
    'herdr --machine prod pane list',
    'herdr plugin log list',
    '/Users/me/.config/herdr/plugins/herdr-sidebar',
    'vim herdr',
    'myherdr',
    '',
  ]) {
    assert.equal(tty.isClientCommand(command), false, command);
  }
});

test('etimeSeconds understands mm:ss, hh:mm:ss, and dd-hh:mm:ss', () => {
  assert.equal(tty.etimeSeconds('05:00'), 300);
  assert.equal(tty.etimeSeconds('03:21:11'), 12071);
  assert.equal(tty.etimeSeconds('2-03:04:05'), 183845);
  assert.equal(tty.etimeSeconds('nonsense'), 0);
  assert.equal(tty.etimeSeconds(undefined), 0);
});

test('isUsableTty rejects process-less ttys', () => {
  assert.equal(tty.isUsableTty('ttys004'), true);
  assert.equal(tty.isUsableTty('pts/3'), true);
  assert.equal(tty.isUsableTty('??'), false);
  assert.equal(tty.isUsableTty('-'), false);
  assert.equal(tty.isUsableTty(''), false);
});

test('devicePath builds a /dev path on both platforms', () => {
  assert.equal(tty.devicePath('ttys004'), '/dev/ttys004');
  assert.equal(tty.devicePath('pts/3'), '/dev/pts/3');
  assert.equal(tty.devicePath('/dev/ttys004'), '/dev/ttys004');
});

test('discover returns explicit overrides without scanning', async () => {
  const found = await tty.discover({ ttys: ['/definitely/not/a/tty'], tty_refresh_ms: 5000 });
  assert.deepEqual(found, []);
});
