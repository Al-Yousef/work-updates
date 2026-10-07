'use strict';
const { app, BrowserWindow, session } = require('electron'),
  path = require('node:path'),
  fs = require('node:fs'),
  http = require('node:http'),
  crypto = require('node:crypto');
if (process.env.HYPHEN_BROWSER_AUDIT !== '1' || !path.isAbsolute(process.argv[2] || ''))
  throw new Error('Only an explicitly isolated synthetic browser fixture is supported.');
const directory = process.argv[2];
fs.mkdirSync(directory, { recursive: true });
app.setPath('userData', path.join(directory, 'electron-profile'));
const { BrowserSessions } = require('../src/browser-sessions.cjs'),
  { createFactory } = require('../src/browser-electron.cjs');
let server, store;
app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  store?.shutdown();
  server?.close();
});
app
  .whenReady()
  .then(async () => {
    server = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<!doctype html><title>Owned browser fixture</title><h1>Owned browser fixture</h1><p>Only synthetic local page content.</p><input aria-label="Synthetic editable input">',
      );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const actorId = 'human:synthetic-browser',
      input = (text) => ({
        role: 'human',
        authority: 'accepted_human',
        actorId,
        messageId: crypto.randomUUID(),
        text,
      });
    store = new BrowserSessions({
      directory,
      actorId,
      admission: () => 'allow',
      verifyBinding: async () => {},
      create: createFactory({ BrowserWindow, session }),
    });
    const spec = {
      taskId: 'synthetic-local-task',
      grantId: '11111111-1111-4111-8111-111111111111',
      url: origin,
      origins: [origin],
    };
    const created = await store.open(input('/browser open ' + JSON.stringify(spec)), spec);
    global.browserFixture = { store, id: created.sessionId, input, origin };
  })
  .catch((error) => {
    console.error(error.message);
    app.exit(1);
  });
