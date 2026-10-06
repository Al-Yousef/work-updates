'use strict';
const { _electron: electron } = require('playwright');
const {closeAuditApp,forceAuditApp}=require('./electron-audit-lifecycle.cjs');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'),
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-native-pair-'));
let host, companion, viewer, code;
let lastOperation = 'launch';
const auditFlags = process.platform === 'darwin' ? ['--use-mock-keychain'] : [];
const deadline = setTimeout(() => {
  process.stderr.write('Synthetic pairing audit timed out during: ' + lastOperation + '\n');
  process.exitCode = 1;
  for (const app of [companion, viewer, host]) forceAuditApp(app);
}, 150000);
async function invoke(page, method, input) {
  lastOperation = method;
  const result = await page.evaluate(({ method, input }) => window.workUpdates[method](input), {
    method,
    input,
  });
  assert.ok(result.ok, result.error);
  return result.value;
}
async function waitState(page, predicate) {
  lastOperation = 'wait for paired snapshot';
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
    host = await electron.launch({
      args: [root, ...auditFlags, '--demo', '--data-dir', path.join(dir, 'host')],
      timeout: 30000,
    });
    const h = await host.firstWindow({ timeout: 30000 });
    await h.locator('.card-trigger').first().waitFor();
    await invoke(h, 'pair', { host: '127.0.0.1' });
    code = await host.evaluate(({ clipboard }) => clipboard.readText());
    assert.ok(code.startsWith('wu1:'));
    companion = await electron.launch({
      args: [root, ...auditFlags, '--demo', '--data-dir', path.join(dir, 'companion')],
      timeout: 30000,
    });
    const c = await companion.firstWindow({ timeout: 30000 });
    await c.locator('.card-trigger').first().waitFor();
    await invoke(c, 'connect', { code });
    const paired = await invoke(c, 'state');
    assert.equal(paired.remote, true);
    assert.equal(
      paired.cards.length,
      6,
      'Pairing preserves three local and three remote sample chats',
    );
    const hostId = paired.devices.find((d) => !d.local).id;
    assert.equal(
      new Set(paired.cards.map((c) => c.id)).size,
      6,
      'Equal sample chat IDs on two computers are namespaced',
    );
    viewer = await electron.launch({
      args: [root, ...auditFlags, '--demo', '--data-dir', path.join(dir, 'viewer')],
      timeout: 30000,
    });
    const v = await viewer.firstWindow({ timeout: 30000 });
    await invoke(v, 'connect', { code });
    const task = await invoke(c, 'create', {
      ownerId: hostId,
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
    const remoteTaskId = task.id.slice(('peer:' + hostId + ':').length);
    await waitState(v, (s) =>
      s.cards.some((card) => card.id.endsWith(':' + remoteTaskId) && card.status === 'ready'),
    );
    await invoke(c, 'action', { id: task.id, action: 'reviewed' });
    await waitState(
      v,
      (s) => s.cards.find((card) => card.id.endsWith(':' + remoteTaskId))?.reviewed,
    );
    assert.equal(
      (await invoke(h, 'state')).cards.find((card) => card.id === remoteTaskId).reviewed,
      true,
    );
    await invoke(c, 'action', { id: task.id, action: 'snooze' });
    await waitState(
      v,
      (s) => s.cards.find((card) => card.id.endsWith(':' + remoteTaskId))?.snoozed,
    );
    await invoke(c, 'undo');
    await waitState(
      v,
      (s) => !s.cards.find((card) => card.id.endsWith(':' + remoteTaskId))?.snoozed,
    );
    await invoke(c, 'action', { id: task.id, action: 'done' });
    assert.equal(
      (await invoke(h, 'state')).done.find((t) => t.id === remoteTaskId).title,
      task.title,
    );
    await invoke(h, 'revoke');
    await waitState(c, (state) => !state.devices.find((d) => d.id === hostId)?.online);
    await c.waitForFunction(() =>
      [...document.querySelectorAll('.badge.unknown')].some((e) =>
        e.textContent.endsWith(' offline'),
      ),
    );
    assert.ok(
      await c.locator('.card-age').filter({ hasText: 'Last synced' }).count(),
      'Offline cards label the age of their cached context',
    );
    assert.ok(
      await c.locator('.swipe-actions button:disabled').count(),
      'Offline swipe actions cannot be submitted',
    );
    const offline = await invoke(c, 'action', { id: task.id, action: 'reopen' }).then(
      () => false,
      () => true,
    );
    assert.equal(offline, true, 'Offline remote actions never mutate the companion local queue');
    assert.equal(fs.existsSync(path.join(dir, 'host', 'paired-host.enc')), false);
    await invoke(c, 'disconnect');
    assert.equal(fs.existsSync(path.join(dir, 'companion', 'paired-devices.enc')), false);
    process.stdout.write(
      'Three native windows: merged queues, collision-safe reply, shared Reviewed/Snooze/Undo/Done, offline refusal and revoke passed.\n',
    );
  } finally {
    try {
    if (host && code)
      await host
        .evaluate(({ clipboard }, value) => {
          if (clipboard.readText() === value) clipboard.writeText('');
        }, code)
        .catch(() => {});
      const closed=await Promise.allSettled([companion,viewer,host].map(closeAuditApp));
      const errors=closed.filter(result=>result.status==='rejected').map(result=>result.reason);
      if(errors.length) throw new AggregateError(errors,'Synthetic pairing apps did not shut down cleanly\n'+errors.map(error=>error.stack).join('\n'));
    } finally {
      clearTimeout(deadline);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
})().catch((error) => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
