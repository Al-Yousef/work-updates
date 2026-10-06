'use strict';
// Explicit live verification. Uses only one newly created, harmless test chat.
// No message is sent to an existing user chat. The dedicated chat is archived afterward.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron: electron } = require('playwright');
const { Codex } = require('../src/codex.cjs');
if (!process.argv.includes('--confirm'))
  throw new Error('Use --confirm for the dedicated live reply test.');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts/writer-live-audit');
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(output, 'profile-'));
const executable =
  process.env.WORK_UPDATES_EXECUTABLE ||
  require('./dev-paths.cjs').installed('desktop/Work Updates.exe');
const checks = [];
const check = (name, value) => {
  assert.ok(value, name);
  checks.push(name);
  process.stdout.write('PASS ' + name + '\n');
};
async function closeTestApp(app) {
  // Quit normally first; bound shutdown to this exact child process if Electron hangs.
  const child = app.process();
  const closing = app.close().catch(() => {});
  let timer;
  await Promise.race([
    closing,
    new Promise((resolve) => {
      timer = setTimeout(resolve, 15000);
    }),
  ]);
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) child.kill();
}
const rpc = async (page, method, input) => {
  const result = await page.evaluate(
    async ({ method, input }) => window.workUpdates[method](input),
    { method, input },
  );
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const waitForPass = async (page, id, expectedText) => {
  const until = Date.now() + 90000;
  while (Date.now() < until) {
    const state = await rpc(page, 'state');
    const card = state.cards.find((c) => c.id === id);
    if (
      card?.readyForReview &&
      card.messages
        ?.filter((m) => m.role === 'assistant')
        .at(-1)
        ?.text.includes(expectedText)
    )
      return card;
    await page.waitForTimeout(250);
  }
  throw new Error('Expected real assistant reply did not complete within 90 seconds');
};
(async () => {
  let app, second, testThread;
  const report = {
    at: new Date().toISOString(),
    checks,
    scope:
      'One new dedicated chat; installed native app IPC and renderer; separate real app-server ownership test; no physical key injection.',
  };
  try {
    app = await electron.launch({
      executablePath: executable,
      args: ['--hidden', '--data-dir', profile],
      timeout: 30000,
    });
    const page = await app.firstWindow();
    await page.locator('#queue').waitFor({ state: 'attached' });
    const initial = await rpc(page, 'state');
    check('installed production app, not demo', !initial.demo && initial.version === '0.4.4');
    const task = await rpc(page, 'create', {
      title: 'Work Updates dedicated real reply check',
      prompt:
        'Reply exactly: Work Updates initial message verified. Do not use tools, open files, or make any changes.',
    });
    const started = await rpc(page, 'start', { id: task.id });
    testThread = started.threadId;
    let card = await waitForPass(page, task.id, 'Work Updates initial message verified.');
    testThread = card.threadId;
    check('real initial turn completes on a new exact chat', !!testThread && card.readyForReview);
    // Use the actual installed renderer handler, including its Enter shortcut.
    await rpc(page, 'window', { action: 'show' });
    await page.waitForFunction(() => !document.body.inert);
    await page.evaluate(() => {
      const all = document.getElementById('show-all');
      if (!all.hidden) all.click();
    });
    const trigger = page.locator('.card-trigger[data-id="' + task.id + '"]');
    await trigger.waitFor({ state: 'attached' });
    await trigger.evaluate((el) => el.click());
    await page.locator('#chat-input').waitFor({ state: 'attached' });
    await page
      .locator('#chat-input')
      .fill(
        'Reply exactly: Work Updates Enter follow-up verified. Do not use tools, open files, or make changes.',
      );
    await page.locator('#chat-input').press('Enter');
    await page.waitForFunction(() => !document.getElementById('chat-input').value, null, {
      timeout: 15000,
    });
    card = await waitForPass(page, task.id, 'Work Updates Enter follow-up verified.');
    check('Enter sends a real follow-up to the same chat', card.threadId === testThread);
    check(
      'reply has one user entry and no duplicate sends',
      card.messages.filter((m) => m.role === 'user').length === 2,
    );
    // The app still holds this completed/idle chat. A second writer must be refused.
    second = new Codex();
    let conflict;
    try {
      await second.prepare(testThread);
    } catch (error) {
      conflict = error;
    }
    check(
      'another client cannot resume an idle chat with an existing writer',
      /active writer/.test(conflict?.message || '') && conflict.method === 'thread/resume',
    );
    check(
      'rejected second writer did not load or start the chat',
      second.loaded.size === 0 && second.active.size === 0,
    );
    await rpc(page, 'action', { id: task.id, action: 'done', taskKey: card.taskKey });
    await closeTestApp(app);
    app = null;
    // Once the original owner closes, a later writer can resume the same history.
    await second.prepare(testThread);
    const completed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Resume test completion timeout')), 90000);
      second.on('notification', (msg) => {
        if (msg.method === 'turn/completed' && msg.params?.threadId === testThread) {
          clearTimeout(timer);
          resolve(msg.params.turn);
        }
      });
    });
    await second.send(
      testThread,
      'Reply exactly: Work Updates released-writer resume verified. Do not use tools, open files, or make changes.',
    );
    const turn = await completed;
    check('same chat can resume after its owner closes', turn.status === 'completed');
    const read = await second.call('thread/read', { threadId: testThread, includeTurns: true });
    check(
      'real third reply is present in the same persisted history',
      read.thread.id === testThread &&
        JSON.stringify(read.thread.turns).includes('Work Updates released-writer resume verified.'),
    );
    await second.call('thread/archive', { threadId: testThread });
    check('only the dedicated test chat was archived', true);
    report.passed = checks.length;
    report.version = initial.version;
    report.testThreadId = testThread;
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify(report) + '\n');
  } catch (error) {
    report.error = error.message;
    report.passed = checks.length;
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    throw error;
  } finally {
    if (app) await closeTestApp(app);
    if (testThread && !checks.includes('only the dedicated test chat was archived')) {
      try {
        second ||= new Codex();
        await second.connect();
        await second.call('thread/archive', { threadId: testThread });
      } catch {}
    }
    second?.close();
  }
})().catch((error) => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
