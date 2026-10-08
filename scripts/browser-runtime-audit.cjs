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
    await page.evaluate(() => {
      localStorage.setItem('synthetic-login', 'owned-fixture-only');
      document.cookie = 'synthetic_login=owned-fixture-only; Path=/';
    });
    const result = await app.evaluate(async ({ BrowserWindow, session }) => {
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
      const isolated = window.webContents.session;
      const unrelated = session.fromPartition('hyphen-unrelated-audit-' + f.id);
      await unrelated.cookies.set({ url: f.origin, name: 'synthetic_other_session',
        value: 'owned-other-fixture-only' });
      if (!(await isolated.cookies.get({})).some((c) => c.name === 'synthetic_login'))
        throw new Error('Synthetic session cookie was not established');
      const cleared = await f.store.clearLogin(f.input('/browser clear-login ' + f.id), f.id);
      const probe = new BrowserWindow({ show: false, webPreferences: {
        session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true,
      }});
      let localStorageCleared;
      try {
        await probe.loadURL(f.origin);
        localStorageCleared = await probe.webContents.executeJavaScript(
          'localStorage.getItem("synthetic-login") === null');
      } finally { probe.destroy(); }
      return {
        persistent,
        readContainsFixture: read.text.includes('Owned browser fixture'),
        staleRefused,
        visible,
        owner,
        closed: f.store.entry(f.id).owner === 'closed',
        originalWindowDestroyed: window.isDestroyed(),
        cookiesCleared: (await isolated.cookies.get({})).length === 0,
        localStorageCleared,
        clearReceipt: cleared.loginStorageCleared === true,
        unrelatedPartitionPreserved: (await unrelated.cookies.get({})).some(
          (c) => c.name === 'synthetic_other_session'),
      };
    });
    assert.equal(result.persistent, false);
    assert.equal(result.readContainsFixture, true);
    assert.equal(result.staleRefused, true);
    assert.equal(result.visible, true);
    assert.equal(result.owner, 'human');
    assert.equal(result.closed, true);
    assert.equal(result.originalWindowDestroyed, true);
    assert.equal(result.cookiesCleared, true);
    assert.equal(result.localStorageCleared, true);
    assert.equal(result.clearReceipt, true);
    assert.equal(result.unrelatedPartitionPreserved, true);
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
