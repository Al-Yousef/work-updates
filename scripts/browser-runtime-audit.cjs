'use strict';
const { _electron } = require('playwright'),
  fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const directory = path.resolve(__dirname, '../artifacts/browser-runtime');
fs.mkdirSync(directory, { recursive: true });
(async () => {
  let app;
  try {
    app = await _electron.launch({
      args: [path.resolve(__dirname, 'browser-runtime-fixture.cjs'), directory],
      env: { ...process.env, HYPHEN_BROWSER_AUDIT: '1' },
      timeout: 30000,
    });
    const page = await app.firstWindow({ timeout: 30000 });
    await page.waitForSelector('h1');
    assert.equal(await page.evaluate(() => typeof require), 'undefined');
    assert.equal(await page.evaluate(() => typeof process), 'undefined');
    await page.getByLabel('Synthetic editable input').fill('Human-owned fixture input');
    const result = await app.evaluate(async ({ BrowserWindow }) => {
      let f;
      for (let i = 0; i < 100; i++) {
        f = global.browserFixture;
        if (f?.id) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      if (!f?.id) throw new Error('Browser ownership fixture is not ready');
      const window = BrowserWindow.getAllWindows()[0],
        persistent = window.webContents.session.isPersistent();
      await f.store.returnControl(f.input('/browser return ' + f.id), f.id);
      if (window.isVisible())
        throw new Error('Automated browser still accepts visible human input');
      const lease = f.store.lease(f.id),
        read = await f.store.read(lease);
      await f.store.takeover(f.input('/browser takeover ' + f.id), f.id);
      let staleRefused = false;
      try {
        await f.store.read(lease);
      } catch {
        staleRefused = true;
      }
      const visible = window.isVisible(),
        owner = f.store.entry(f.id).owner;
      f.store.close(f.input('/browser close ' + f.id), f.id);
      return {
        persistent,
        readContainsFixture: read.text.includes('Owned browser fixture'),
        staleRefused,
        visible,
        owner,
        closed: f.store.entry(f.id).owner === 'closed',
      };
    });
    assert.equal(result.persistent, false);
    assert.equal(result.readContainsFixture, true);
    assert.equal(result.staleRefused, true);
    assert.equal(result.visible, true);
    assert.equal(result.owner, 'human');
    assert.equal(result.closed, true);
    await app.close();
    app = null;
    fs.writeFileSync(
      path.join(directory, 'verification.json'),
      JSON.stringify(
        {
          schema: 1,
          passed: true,
          evidence: 'isolated Electron private browser and ownership handoff',
          accountsUsed: 0,
          modelCalls: 0,
          installedAppChanged: false,
          ...result,
        },
        null,
        2,
      ),
    );
    console.log('Isolated browser runtime and ownership checks passed.');
  } finally {
    if (app) await app.close();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
