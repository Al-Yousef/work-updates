'use strict';
const { _electron: electron, expect } = require('playwright');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'),
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-ui-')),
  output = path.join(root, 'artifacts', 'ui');
fs.mkdirSync(output, { recursive: true });
let app;
let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks++;
};
async function waitFor(page, fn) {
  await page.waitForFunction(fn, null, { timeout: 12000 });
}
(async () => {
  try {
    const executablePath = process.env.WORK_UPDATES_EXECUTABLE;
    app = await electron.launch({
      executablePath,
      args: [...(!executablePath ? [root] : []), '--demo', '--data-dir', dir],
      timeout: 30000,
    });
    const page = await app.firstWindow();
    const nativeScreenshot = page.screenshot.bind(page);
    page.screenshot = async (options) => {
      await page.waitForTimeout(200);
      return nativeScreenshot(options);
    };
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.locator('.card-trigger').first().waitFor();
    check((await page.locator('.card-trigger').count()) === 3, 'Synthetic queue loads');
    check(
      (await page.evaluate(() => typeof require)) === 'undefined',
      'Renderer has no Node access',
    );
    await page.screenshot({ path: path.join(output, 'queue.png') });
    await page.getByRole('button', { name: 'Review launch notes, Ready to review' }).click();
    check(
      (await page.getByRole('button', { name: 'Open chat ↗', exact: true }).count()) === 1,
      'Click opens actions',
    );
    check(
      (await page.locator('#chat-input').count()) === 0,
      'Details remain behind deliberate action',
    );
    await page.screenshot({ path: path.join(output, 'actions.png') });
    await page.getByRole('button', { name: '✓ Mark done', exact: true }).click();
    await waitFor(page, () => document.querySelector('#scrim').hidden);
    check((await page.locator('.card-trigger').count()) === 2, 'Done removes update');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await waitFor(page, () => document.querySelectorAll('.card-trigger').length === 3);
    check(true, 'Undo restores task');
    const launch = page.getByRole('button', { name: 'Review launch notes, Ready to review' });
    await launch.click({ button: 'right' });
    check((await page.locator('#chat-input').count()) === 1, 'Right click opens conversation');
    await page.keyboard.press('Escape');
    await launch.focus();
    await page.keyboard.press('Shift+F10');
    check((await page.locator('#chat-input').count()) === 1, 'Keyboard contextual route');
    await page.keyboard.press('Escape');
    check(await launch.evaluate((e) => e === document.activeElement), 'Focus returns to card');
    const bounds = await launch.boundingBox();
    await page.mouse.move(bounds.x + 80, bounds.y + 45);
    await page.mouse.down();
    await page.waitForTimeout(750);
    await page.mouse.up();
    check(
      (await page.locator('#chat-input').count()) === 1,
      'Hold opens conversation exactly once',
    );
    await page.screenshot({ path: path.join(output, 'chat.png') });
    await page.keyboard.press('Escape');
    await page.mouse.move(bounds.x + 80, bounds.y + 45);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 105, bounds.y + 45);
    await page.waitForTimeout(750);
    await page.mouse.up();
    check(await page.locator('#scrim').isHidden(), 'Dragging cancels hold and click');
    await page.getByRole('button', { name: 'New task', exact: false }).first().click();
    await page.locator('#task-title').fill('Check the compact task queue');
    await page.locator('#task-prompt').fill('Verify a sample task without changing files.');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'New task', exact: false }).first().click();
    check(
      (await page.locator('#task-title').inputValue()) === 'Check the compact task queue',
      'Composer draft survives cancel',
    );
    await page.screenshot({ path: path.join(output, 'composer.png') });
    await page.getByRole('button', { name: 'Queue task', exact: true }).click();
    await page.locator('[data-view=queued]').click();
    await page.locator('.card-trigger').first().click();
    await page.getByRole('button', { name: 'Start chat', exact: true }).click();
    await waitFor(page, () =>
      document.querySelector('#panel-status').textContent.includes('Ready to review'),
    );
    check(true, 'Queued task starts a dedicated demo chat');
    await page.locator('#chat-input').fill('Confirm the follow-up message.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await waitFor(
      page,
      () =>
        document.querySelectorAll('.message.user').length === 2 &&
        document.querySelector('#panel-status').textContent.includes('Ready to review'),
    );
    check(true, 'Mini chat receives follow-up completion');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Updates', exact: true }).click();
    await page
      .getByRole('button', { name: 'Check the compact task queue, Ready to review' })
      .click();
    await page.getByRole('button', { name: '✓ Mark done', exact: true }).click();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.locator('.card-trigger').first().click();
    await page.getByRole('button', { name: 'Reopen task', exact: true }).click();
    check(true, 'Done list reopens local task');
    await page.getByRole('button', { name: 'Updates', exact: true }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(390, 590));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.screenshot({ path: path.join(output, 'compact.png') });
    check(
      await page.evaluate(() => document.body.scrollWidth <= innerWidth),
      'Compact window avoids horizontal overflow',
    );
    await page.getByRole('button', { name: 'New task', exact: false }).first().click();
    await page.evaluate(() => (document.body.style.zoom = '1.25'));
    await page.screenshot({ path: path.join(output, 'composer-zoom.png') });
    check(
      await page.locator('#queue-task').isVisible(),
      'Composer primary remains reachable at zoom',
    );
    check(errors.length === 0, 'No renderer exceptions');
    process.stdout.write(
      'Native desktop UI: ' + checks + ' checks passed. Synthetic screenshots: artifacts/ui\n',
    );
  } finally {
    if (app) await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
