'use strict';
const { app, BrowserWindow, ipcMain, protocol, screen, Tray, Menu } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { startPreview } = require('../server.cjs');
const { ReviewWindow } = require('./window.cjs');
const {
  SCHEME,
  ORIGIN,
  APP_ID,
  APP_NAME,
  privateRoot,
  prepare,
  recoveryRecord,
  atomicJson,
  owns,
  route,
} = require('./policy.cjs');
const root = path.resolve(__dirname, '../../..');
function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}
const auditHidden = process.argv.includes('--audit-hidden');
const protocolFixtures =
  process.argv.includes('--protocol-fixtures') ||
  (app.isPackaged && require(path.join(root, 'package.json')).dotInboxProtocolFixtures === true);
const hostAppId = APP_ID + (protocolFixtures ? '.protocol' : '');
const hostAppName = protocolFixtures ? 'Work Updates Protocol Review' : APP_NAME;
const allowed = app.isPackaged
  ? path.join(path.dirname(app.getPath('exe')), 'review-data')
  : path.join(root, 'artifacts', 'dot-inbox', 'desktop-review');
fs.mkdirSync(allowed, { recursive: true });
const directory = privateRoot(
  allowed,
  option('--review-dir') || path.join(allowed, protocolFixtures ? 'protocol' : 'personal'),
);
if (protocolFixtures && option('--seed-from'))
  throw new Error(
    'Protocol fixtures use separate identities and recovery. The original seed is preserved.',
  );
const store = prepare(directory, option('--seed-from'));
app.setName(hostAppName);
app.setAppUserModelId(hostAppId);
app.setPath('userData', store.userData);
app.setPath('sessionData', store.userData);
app.commandLine.appendSwitch('disable-background-networking');
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);
let window,
  controller,
  preview,
  tray,
  quitting = false;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  // A second launch never activates the candidate or somebody else's task.
  app.on('second-instance', () => {});
  app
    .whenReady()
    .then(async () => {
      preview = await startPreview({
        recoveryRoot: store.receipts,
        sessionsRoot: path.join(directory, 'sessions'),
        protocolFixtures,
      });
      protocol.handle(SCHEME, async (request) => {
        try {
          const pathname = route(request);
          if (pathname === '/desktop.css')
            return new Response(fs.readFileSync(path.join(__dirname, 'desktop.css')), {
              headers: { 'Content-Type': 'text/css' },
            });
          const init = {
            method: request.method,
            headers: {
              Origin: preview.origin,
              'X-Dot-Preview': 'fixture',
              'Content-Type': 'application/json',
            },
          };
          if (request.method === 'POST') init.body = await request.text();
          const response = await fetch(preview.origin + pathname, init);
          if (pathname === '/' || pathname === '/index.html') {
            const html = (await response.text())
              .replace('</head>', '<link rel="stylesheet" href="/desktop.css" /></head>')
              .replace(
                '<body>',
                '<body class="desktop-review"><div id="dot-grip" title="Drag the dot"></div>',
              );
            return new Response(html, { status: response.status, headers: response.headers });
          }
          return new Response(await response.arrayBuffer(), {
            status: response.status,
            headers: response.headers,
          });
        } catch (error) {
          return new Response(JSON.stringify({ error: error.message }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      });
      window = new BrowserWindow({
        width: 76,
        height: 76,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        show: false,
        focusable: false,
        skipTaskbar: true,
        resizable: false,
        maximizable: false,
        fullscreenable: false,
        hasShadow: false,
        title: hostAppName,
        icon: path.join(root, 'assets', 'icon.png'),
        webPreferences: {
          preload: path.join(__dirname, 'preload.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
        },
      });
      window.setAlwaysOnTop(true, 'floating');
      window.setMenu(null);
      controller = new ReviewWindow(window, screen, store.placement, { auditHidden });
      const guard = (event) => {
        if (!owns(event, window)) throw new Error('Untrusted review frame.');
      };
      ipcMain.handle('dot-review:bootstrap', (event) => {
        guard(event);
        return { appId: hostAppId, appName: hostAppName, state: controller.state() };
      });
      ipcMain.handle('dot-review:window', (event, intent) => {
        guard(event);
        if (
          !intent ||
          Object.keys(intent).some((key) => !['expanded', 'userInitiated'].includes(key))
        )
          throw new Error('Invalid window intent.');
        return controller.apply(intent.expanded, intent.userInitiated);
      });
      ipcMain.on('dot-review:read', (event) => {
        try {
          guard(event);
          const raw = fs.existsSync(store.client) ? fs.readFileSync(store.client, 'utf8') : null;
          if (raw) recoveryRecord(raw);
          event.returnValue = { ok: true, value: raw };
        } catch (error) {
          event.returnValue = { ok: false, error: error.message };
        }
      });
      ipcMain.on('dot-review:write', (event, raw) => {
        try {
          guard(event);
          atomicJson(store.client, recoveryRecord(raw));
          event.returnValue = { ok: true };
        } catch (error) {
          event.returnValue = { ok: false, error: error.message };
        }
      });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event) => event.preventDefault());
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      window.webContents.session.setPermissionCheckHandler(() => false);
      window.on('close', (event) => {
        if (!quitting) {
          event.preventDefault();
          controller.apply(false);
          window.webContents.send('dot-review:collapse');
        }
      });
      window.once('ready-to-show', () => controller.present());
      if (!auditHidden) {
        tray = new Tray(path.join(root, 'assets', 'icon.png'));
        tray.setToolTip(hostAppName + ' · synthetic review');
        tray.setContextMenu(
          Menu.buildFromTemplate([
            {
              label: 'Collapse to dot',
              click: () => {
                controller.apply(false);
                window.webContents.send('dot-review:collapse');
              },
            },
            {
              label: 'Local review controls',
              click: () => {
                controller.apply(true, true);
                window.webContents.send('dot-review:tools');
              },
            },
            { type: 'separator' },
            {
              label: 'Quit Work Updates Review',
              click: () => {
                quitting = true;
                app.quit();
              },
            },
          ]),
        );
      }
      // Audit API stays inside the main process; it is never exposed to the renderer.
      globalThis.dotReviewAudit = {
        appId: hostAppId,
        directory,
        store,
        preview,
        window,
        controller,
      };
      await window.loadURL(ORIGIN + '/');
    })
    .catch((error) => {
      process.stderr.write(error.stack + '\n');
      quitting = true;
      app.quit();
    });
}
app.on('window-all-closed', () => {
  if (quitting) app.quit();
});
app.on('before-quit', () => {
  quitting = true;
  window?.webContents.session.flushStorageData();
  tray?.destroy();
});
app.on('will-quit', () => {
  preview?.fixture.close();
  preview?.server.close();
});
