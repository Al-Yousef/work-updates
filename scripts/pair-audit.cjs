'use strict';
const { _electron: electron } = require('playwright');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'),
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-native-pair-'));
let host, companion, code;
async function invoke(page, method, input) {
  const result = await page.evaluate(({ method, input }) => window.workUpdates[method](input), {
    method,
    input,
  });
  assert.ok(result.ok, result.error);
  return result.value;
}
async function waitState(page, predicate) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const state = await invoke(page, 'state');
    if (predicate(state)) return state;
    await page.waitForTimeout(100);
  }
  throw new Error('Paired state did not arrive.');
}
(async () => {
  try {
    host = await electron.launch({ args: [root, '--demo', '--data-dir', path.join(dir, 'host')] });
    const h = await host.firstWindow();
    await h.locator('.card-trigger').first().waitFor();
    await invoke(h, 'pair', { host: '127.0.0.1' });
    code = await host.evaluate(({ clipboard }) => clipboard.readText());
    assert.ok(code.startsWith('wu1:'));
    companion = await electron.launch({
      args: [root, '--demo', '--data-dir', path.join(dir, 'companion')],
    });
    const c = await companion.firstWindow();
    await c.locator('.card-trigger').first().waitFor();
    await invoke(c, 'connect', { code });
    assert.equal((await invoke(c, 'state')).remote, true);
    const task = await invoke(c, 'create', {
      title: 'Paired desktop sample',
      prompt: 'Complete this synthetic sample task.',
    });
    await invoke(c, 'start', { id: task.id });
    await waitState(c, (state) => state.cards.find((t) => t.id === task.id)?.status === 'ready');
    const version = (await invoke(c, 'state')).cards.find(
      (t) => t.id === task.id,
    ).notificationVersion;
    await invoke(c, 'send', { id: task.id, text: 'Verify the paired follow-up.' });
    await waitState(c, (state) => {
      const card = state.cards.find((t) => t.id === task.id);
      return (
        card?.status === 'ready' &&
        card.notificationVersion !== version &&
        card.messages.filter((m) => m.role === 'user').length === 2
      );
    });
    await invoke(c, 'action', { id: task.id, action: 'done' });
    assert.equal((await invoke(h, 'state')).done.find((t) => t.id === task.id).title, task.title);
    await invoke(h, 'revoke');
    await waitState(c, (state) => state.connection === 'Reconnecting to desktop');
    assert.equal(fs.existsSync(path.join(dir, 'host', 'paired-host.enc')), false);
    await invoke(c, 'disconnect');
    assert.equal(fs.existsSync(path.join(dir, 'companion', 'paired-remote.enc')), false);
    process.stdout.write(
      'Paired native windows: queue, dedicated chat, reply, Done and revoke passed.\n',
    );
  } finally {
    if (host && code)
      await host
        .evaluate(({ clipboard }, value) => {
          if (clipboard.readText() === value) clipboard.writeText('');
        }, code)
        .catch(() => {});
    if (companion) await companion.close();
    if (host) await host.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
