'use strict';
const { _electron } = require('playwright'),
  path = require('node:path'),
  fs = require('node:fs'),
  assert = require('node:assert/strict');
const { closeAuditApp } = require('./electron-audit-lifecycle.cjs');
const directory = path.resolve(__dirname, '../artifacts/channel-runtime');
fs.mkdirSync(directory, { recursive: true });
(async () => {
  let app;
  try {
    app = await _electron.launch({
      args: [path.resolve(__dirname, 'channel-runtime-fixture.cjs'), directory],
      env: { ...process.env, HYPHEN_CHANNEL_AUDIT: '1' },
      timeout: 30000,
    });
    let page = await app.firstWindow();
    await page.waitForSelector('h1');
    assert.equal(await page.evaluate(() => typeof require), 'undefined');
    assert.equal(await page.evaluate(() => typeof process), 'undefined');
    await page.getByLabel('Device name').fill('My synthetic private phone');
    await page.getByLabel('Private network address').selectOption('127.0.0.1');
    await page.getByRole('button', { name: 'Create private assistant code', exact: true }).click();
    await page.waitForFunction(() =>
      document.getElementById('status').textContent.includes('held'),
    );
    assert.equal(await app.evaluate(() => global.channelFixture.channels.state.entries.length), 0);
    await page.getByLabel('This is my private device.', { exact: false }).check();
    await page.getByRole('button', { name: 'Create private assistant code', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('code').value.startsWith('wua1:'));
    assert.equal(await app.evaluate(() => global.channelFixture.channels.state.entries.length), 1);
    await page.screenshot({
      path: path.join(directory, 'private-device-grant.png'),
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Revoke access', exact: true }).click();
    await page.waitForFunction(() =>
      document.getElementById('status').textContent.includes('held'),
    );
    assert.equal(
      await app.evaluate(() => global.channelFixture.channels.state.entries[0].access),
      'active',
    );
    await page.getByLabel('Confirm this exact grant').check();
    await page.getByRole('button', { name: 'Revoke access', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('code').value === '');
    assert.equal(
      await app.evaluate(() => global.channelFixture.channels.state.entries[0].access),
      'revoked',
    );
    await page.close();
    await app.evaluate(() => global.channelFixture.window.open());
    page = await app.firstWindow();
    await page.waitForSelector('h1');
    assert.equal(await page.getByLabel('One-time code').inputValue(), '');
    assert.equal(
      await page.getByLabel('This is my private device.', { exact: false }).isChecked(),
      false,
    );
    await closeAuditApp(app);
    app = null;
    fs.writeFileSync(
      path.join(directory, 'verification.json'),
      JSON.stringify(
        {
          schema: 1,
          passed: true,
          accountsUsed: 0,
          modelCalls: 0,
          installedAppChanged: false,
          evidence:
            'Sandboxed private grant window, explicit consent and revocation; reopen restores neither code nor consent',
        },
        null,
        2,
      ),
    );
    console.log('Isolated private channel UI checks passed.');
  } finally {
    if (app) await closeAuditApp(app);
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
