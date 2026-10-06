'use strict';
const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts/ai-summary-install');
const directory = fs.mkdtempSync(path.join(output, 'hidden-audit-'));
const checks = [];
const expectedVersion = process.env.WORK_UPDATES_EXPECTED_VERSION || '0.4.2';
const check = (name, condition) => {
  assert.ok(condition, name);
  checks.push(name);
};
(async () => {
  let app;
  try {
    app = await electron.launch({
      executablePath:
        process.env.WORK_UPDATES_EXECUTABLE ||
        path.join(output, 'build/win-unpacked/Work Updates.exe'),
      args: ['--demo', '--hidden', '--data-dir', directory],
      timeout: 30000,
    });
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.locator('.card-trigger').first().waitFor({ state: 'attached' });
    const initial = (await page.evaluate(() => window.workUpdates.state())).value;
    check('packaged version ' + expectedVersion, initial.version === expectedVersion);
    check('hidden startup without requesting user focus', initial.windowMode === 'hidden');
    const runtime = JSON.parse(fs.readFileSync(path.join(directory, 'runtime.json')));
    check('native tray registered', runtime.tray.registered && !runtime.visible);
    // Intercept the owned synthetic Queue instance to exercise presentation through the normal IPC/UI.
    await app.evaluate(({ app }) => {
      const require = process
        .getBuiltinModule('module')
        .createRequire(app.getAppPath() + '/main.cjs');
      const { Queue } = require('./src/queue.cjs');
      const original = Queue.prototype.cards;
      Queue.prototype.cards = function () {
        globalThis.summaryAuditQueue = this;
        return original.call(this);
      };
    });
    await page.evaluate(() => window.workUpdates.state());
    const identity = await app.evaluate(({ app }) => {
      const require = process
        .getBuiltinModule('module')
        .createRequire(app.getAppPath() + '/main.cjs');
      const { summaryKey } = require('./src/summary-key.cjs');
      const q = globalThis.summaryAuditQueue,
        source = q.feed.threads[0];
      const before = q.get(source.id);
      Object.assign(source, {
        turnId: 'synthetic-completion',
        lifecycle: 'completed',
        readyForReview: true,
        contextLoaded: true,
      });
      q.state.settings.aiSummaries = true;
      q.setSummaries(
        new Map([
          [
            summaryKey(source),
            {
              title: 'Review the tested desktop repair',
              summary: 'The repair is prepared and needs your review.',
              model: 'synthetic',
            },
          ],
        ]),
        { enabled: true },
      );
      const after = q.get(source.id);
      return {
        id: after.id,
        chatName: after.chatName,
        title: after.title,
        preserved:
          before.taskKey === after.taskKey &&
          before.fingerprint === after.fingerprint &&
          before.primarySourceId === after.primarySourceId &&
          before.status === after.status,
      };
    });
    check(
      'AI title preserves source, task key, status and notification version',
      identity.preserved,
    );
    await page.waitForFunction(
      (title) =>
        [...document.querySelectorAll('.card-title')].some((el) => el.textContent === title),
      identity.title,
    );
    const rendered = await page.evaluate((title) => {
      const titleElement = [...document.querySelectorAll('.card-title')].find(
        (el) => el.textContent === title,
      );
      const card = titleElement.closest('.card-trigger');
      return {
        chatName: card.querySelector('.meta').textContent,
        summary: card.querySelector('.card-summary').textContent,
      };
    }, identity.title);
    check(
      'original chat name stays above the AI task title',
      rendered.chatName.startsWith(identity.chatName),
    );
    check(
      'AI one-line update reaches the notification card',
      rendered.summary.includes('prepared'),
    );
    await app.evaluate(() => {
      const q = globalThis.summaryAuditQueue;
      q.setSummaries(q.summaries, {
        enabled: true,
        eligible: 4,
        summarized: 1,
        pending: 3,
        failed: 0,
        resumeAt: Date.now() + 30 * 60000,
      });
    });
    await page.waitForFunction(() =>
      document.querySelector('#ai-progress').textContent.includes('resumes in'),
    );
    check(
      'catch-up footer explains coverage, remaining work and budget resume',
      (await page.locator('#ai-progress').textContent()).includes('1/4 ready · 3 remaining'),
    );
    await app.evaluate(() => {
      const q = globalThis.summaryAuditQueue;
      q.setSummaries(q.summaries, {
        enabled: true,
        eligible: 4,
        summarized: 1,
        pending: 0,
        failed: 1,
      });
    });
    await page.waitForFunction(() => document.querySelector('#ai-progress').textContent.includes('need retry'));
    await page.evaluate(() => document.getElementById('settings').click());
    check(
      'AI setting is visible and enabled',
      await page.locator('#setting-aiSummaries').isChecked(),
    );
    check(
      'failed summaries have an explicit retry button',
      (await page.getByRole('button', { name: 'Retry failed AI summaries' }).count()) === 1,
    );
    await page
      .getByRole('button', { name: 'Retry failed AI summaries' })
      .evaluate((el) => el.click());
    await page.waitForFunction(() => document.querySelector('#scrim').hidden);
    check(
      'retry IPC is registered and returns to the queue',
      (await page.locator('#notice').textContent()) === 'No failed summaries to retry',
    );
    await page.evaluate(() => document.getElementById('settings').click());
    await page.locator('#setting-aiSummaries').evaluate((el) => {
      el.checked = false;
      el.dispatchEvent(new Event('change'));
    });
    await page.waitForFunction(
      () => document.querySelector('#setting-aiSummaries')?.checked === false,
    );
    const state = (await page.evaluate(() => window.workUpdates.state())).value;
    check(
      'opt-out uses recorded excerpts',
      state.cards.find((c) => c.id === identity.id).summaryOrigin === 'recorded',
    );
    await page.evaluate(() => document.getElementById('hide').click());
    check(
      'X handler leaves tray app hidden',
      (await page.evaluate(() => window.workUpdates.state())).value.windowMode === 'hidden',
    );
    check('renderer has no errors', errors.length === 0);
    const report = {
      at: new Date().toISOString(),
      checks,
      passed: checks.length,
      mode: 'packaged synthetic hidden audit; no physical input',
    };
    fs.writeFileSync(
      path.join(output, 'desktop-audit-' + expectedVersion + '.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  } finally {
    if (app) await app.close();
  }
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
