'use strict';
const {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  Tray,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  shell,
  dialog,
  screen,
  globalShortcut,
  clipboard,
  safeStorage,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Queue, read, atomic, now } = require('./src/queue.cjs');
const { Codex } = require('./src/codex.cjs');
const { Controller } = require('./src/controller.cjs');
const { startObserver } = require('./src/observer.cjs');
const { WindowController } = require('./src/window-controller.cjs');
const { taskSource } = require('./src/task-source.cjs');
const taskbar = require('./src/taskbar.cjs');
const { dataDirectory, startsVisible } = require('./src/background.cjs');
const { createTray } = require('./src/tray.cjs');
const args = process.argv;
function argument(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
const demo = args.includes('--demo');
const dataDir = dataDirectory({
  explicit: argument('--data-dir'),
  platform: process.platform,
  packaged: app.isPackaged,
  executable: process.execPath,
  fallback: app.getPath('userData'),
  isFile: (file) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  },
});
fs.mkdirSync(dataDir, { recursive: true });
app.setPath('userData', dataDir);
app.setAppUserModelId('io.workupdates.desktop');
protocol.registerSchemesAsPrivileged([
  { scheme: 'work-updates', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
if (!demo && !app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
let window,
  tray,
  corner,
  observer,
  hostPeer,
  remotePeer,
  remoteState,
  windowController,
  cornerTimer,
  concealTimer,
  quitting = false;
let launcherInfo = {
  target: process.platform === 'win32' ? 'weather' : 'corner',
  bounds: null,
  message: '',
};
const queue = new Queue(dataDir);
const client = demo
  ? new (require('./src/demo.cjs').DemoCodex)()
  : new Codex({ binary: queue.state.settings.codexBinary });
const controller = new Controller(queue, client);
const csp =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'none'";
function snapshot() {
  const state = remoteState || queue.snapshot();
  return {
    ...state,
    settings: {
      ...state.settings,
      ...Object.fromEntries(
        ['pin', 'corner', 'attention', 'shortcut'].map((k) => [k, queue.state.settings[k]]),
      ),
    },
    addresses: require('./src/peer.cjs')
      .interfaces()
      .filter((a) => !a.startsWith('127.')),
    demo,
    platform: process.platform,
    remote: !!remotePeer,
    connected: !!remotePeer?.connected,
    version: app.getVersion(),
    hosting: !!hostPeer?.server,
    windowMode: windowController?.mode || 'hidden',
    launcher: { ...launcherInfo, active: !!corner && !corner.isDestroyed() },
    connection: remotePeer?.connected
      ? 'Connected to desktop'
      : remotePeer
        ? 'Reconnecting to desktop'
        : 'Local desktop',
  };
}
function publish() {
  const state = snapshot();
  tray?.update(state);
  if (window && !window.isDestroyed()) window.webContents.send('work-updates:state', state);
  if (corner && !corner.isDestroyed())
    corner.webContents.send('work-updates:state', { windowMode: state.windowMode });
  hostPeer?.broadcast(queue.snapshot());
}
let publication;
queue.on('change', () => {
  if (!publication)
    publication = setTimeout(() => {
      publication = null;
      publish();
    }, 60);
});
const notified = new Set();
function attention(event) {
  if (
    !queue.state.settings.attention ||
    (windowController && windowController.mode !== 'hidden') ||
    !['needs', 'blocked', 'waiting', 'ready'].includes(event.status) ||
    !(
      event.status === 'needs' ||
      event.urgent ||
      (event.status === 'blocked' && event.waitingOn?.kind !== 'other') ||
      event.waitingOn?.kind === 'you'
    ) ||
    notified.has(event.key)
  )
    return;
  notified.add(event.key);
  if (notified.size > 500) notified.delete(notified.values().next().value);
  if (Notification.isSupported()) {
    const notification = new Notification({
      title:
        event.status === 'needs' || event.waitingOn?.kind === 'you'
          ? 'Waiting on you'
          : event.urgent
            ? 'Urgent task'
            : 'A task is blocked',
      body: event.title,
    });
    notification.on('click', () => show());
    notification.show();
  }
}
controller.on('attention', attention);
let previousObserved, previousRemote;
function incoming(cards, previous) {
  const next = new Map(
    cards.map((c) => [
      c.id,
      c.fingerprint + ':' + c.status + ':' + c.urgent + ':' + JSON.stringify(c.waitingOn),
    ]),
  );
  if (previous)
    for (const card of cards)
      if (
        previous.get(card.id) !== next.get(card.id) &&
        !card.done &&
        !card.reviewed &&
        !card.snoozed
      )
        attention({
          key: card.id + ':' + next.get(card.id),
          title: card.title,
          status: card.status,
          urgent: card.urgent,
          waitingOn: card.waitingOn,
        });
  return next;
}
function show() {
  windowController?.show();
}
function toggle() {
  windowController?.toggle();
}
app.on('second-instance', (_event, argv) => {
  if (startsVisible(argv)) show();
});
function refreshCorner() {
  const previous = JSON.stringify(launcherInfo);
  const display = screen.getPrimaryDisplay();
  const area = display.workArea;
  launcherInfo =
    process.platform === 'win32'
      ? taskbar.weatherTarget(display, taskbar.readLayout())
      : {
          target: 'corner',
          bounds: { width: 44, height: 44, x: area.x + 12, y: area.y + area.height - 56 },
          message: '',
        };
  if (process.platform === 'win32' && !queue.state.settings.corner && launcherInfo.bounds)
    launcherInfo.message = 'Weather shortcut off. Windows Widgets uses the weather area.';
  if (!queue.state.settings.corner || !launcherInfo.bounds) {
    if (windowController.enabled) windowController.enable(false);
    corner?.destroy();
    corner = null;
    if (previous !== JSON.stringify(launcherInfo)) publish();
    return;
  }
  if (corner && !corner.isDestroyed()) {
    if (previous !== JSON.stringify(launcherInfo)) {
      corner.setBounds(launcherInfo.bounds);
      publish();
    }
    return;
  }
  corner = new BrowserWindow({
    ...launcherInfo.bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    show: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const control = corner;
  control.once('ready-to-show', () => {
    if (corner !== control || control.isDestroyed()) return;
    if (launcherInfo.target === 'weather') control.setAlwaysOnTop(true, 'pop-up-menu');
    control.showInactive();
    if (launcherInfo.target === 'weather') control.moveTop();
    windowController.enable(true);
    publish();
  });
  corner.loadURL(
    'work-updates://app/' + (launcherInfo.target === 'weather' ? 'weather.html' : 'corner.html'),
  );
  corner.webContents.on('will-navigate', (e) => e.preventDefault());
  corner.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  corner.webContents.on('did-finish-load', publish);
}
function cornerWindow() {
  clearInterval(cornerTimer);
  refreshCorner();
  if (!queue.state.settings.corner) return;
  let ticks = 0;
  cornerTimer = setInterval(() => {
    if (++ticks % 100 === 0) refreshCorner();
    if (!corner || corner.isDestroyed() || window.isDestroyed()) return;
    windowController.tick(screen.getCursorScreenPoint());
    if (launcherInfo.target === 'weather' && windowController.onCorner) {
      // Explorer can raise the taskbar after this window was shown. Keep the
      // transparent click target in front while its region is being used.
      if (!corner.isAlwaysOnTop()) corner.setAlwaysOnTop(true, 'pop-up-menu');
      corner.moveTop();
    }
  }, 100);
  cornerTimer.unref();
}
function configureWindowLevel() {
  const above = queue.state.settings.pin !== false || windowController.mode === 'peek';
  if (window.isAlwaysOnTop() !== above)
    // Windows' default floating level moves behind Explorer's taskbar, which
    // can also clear topmost. The queue already stays inside the work area.
    window.setAlwaysOnTop(above, process.platform === 'win32' ? 'pop-up-menu' : 'floating');
}
function configure() {
  configureWindowLevel();
  cornerWindow();
  globalShortcut.unregisterAll();
  const key = process.platform === 'darwin' ? 'Command+Option+Space' : 'Control+Alt+Space';
  queue.state.settings.shortcut = globalShortcut.register(key, toggle)
    ? key
    : 'Shortcut unavailable';
}
async function perform(method, input = {}) {
  if (
    remotePeer &&
    [
      'create',
      'start',
      'action',
      'undo',
      'send',
      'stop',
      'respond',
      'details',
      'group',
      'refresh',
    ].includes(method)
  )
    return remotePeer.command(method, input);
  if (method === 'state') return snapshot();
  if (method === 'create') {
    if (input.cwd && !(queue.state.settings.projects || []).includes(input.cwd))
      throw new Error('Choose a workspace with the folder picker.');
    return queue.create(input);
  }
  if (method === 'start') return controller.start(input.id);
  if (method === 'action') return queue.action(input.id, input.action, input.taskKey);
  if (method === 'undo') return queue.undoLast();
  if (method === 'group') return queue.group(input);
  if (method === 'refresh') {
    observer?.request([]);
    return {};
  }
  if (method === 'send')
    return controller.send(input.id, input.text, input.sourceId, input.taskKey);
  if (method === 'stop') return controller.stop(input.id);
  if (method === 'respond') return controller.respond(input.id, input.decision, input.answers);
  if (method === 'details') {
    const card = queue.get(input.id);
    observer?.request(card.sources.filter((s) => !s.contextLoaded).map((s) => s.id));
    return card;
  }
  if (method === 'open') {
    const card = remoteState
      ? [...remoteState.done, ...remoteState.cards].find(
          (c) => c.taskKey === input.id || c.id === input.id,
        )
      : queue.get(input.id, input.taskKey);
    if (input.taskKey && card?.taskKey !== input.taskKey)
      throw new Error('This task changed. Reopen its update.');
    const source = taskSource(card, input.sourceId);
    if (!source || !/^[a-f0-9-]{36}$/i.test(source.id))
      throw new Error('No source chat is available.');
    if (demo) return { sourceId: source.id };
    await shell.openExternal('codex://threads/' + source.id);
    return { sourceId: source.id };
  }
  if (method === 'project') {
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory'],
      title: 'Choose task workspace',
    });
    if (result.canceled) return {};
    const cwd = result.filePaths[0];
    queue.state.settings.projects = [...new Set([...(queue.state.settings.projects || []), cwd])];
    queue.save();
    return { cwd };
  }
  if (method === 'settings') {
    for (const key of ['pin', 'corner', 'attention'])
      if (typeof input[key] === 'boolean') queue.state.settings[key] = input[key];
    queue.save();
    configure();
    return snapshot();
  }
  if (method === 'window') {
    if (input.action === 'hide') windowController.hide();
    else if (input.action === 'toggle') toggle();
    else if (input.action === 'corner') windowController.clickCorner();
    else if (input.action === 'retain') windowController.retain();
    else if (input.action === 'show') show();
    else if (input.action === 'quit') {
      quitting = true;
      app.quit();
    } else if (input.action === 'new') {
      show();
      window.webContents.send('work-updates:state', { ...snapshot(), openComposer: true });
    }
    return {};
  }
  if (method === 'updates') {
    if (demo) return { message: 'Demo mode does not check releases.' };
    const response = await fetch(
      'https://api.github.com/repos/Al-Yousef/work-updates/releases/latest',
      { headers: { Accept: 'application/vnd.github+json' } },
    );
    if (!response.ok) throw new Error('No published release is available yet.');
    const release = await response.json();
    if (!/^https:\/\/github\.com\/Al-Yousef\/work-updates\/releases\/tag\//.test(release.html_url))
      throw new Error('Unexpected release URL.');
    await shell.openExternal(release.html_url);
    return { version: release.tag_name };
  }
  if (['pair', 'connect', 'disconnect', 'revoke'].includes(method)) {
    return connectionAction(method, input);
  }
  throw new Error('Unknown app action.');
}
async function connectionAction(method, input) {
  const { HostPeer, RemotePeer } = require('./src/peer.cjs');
  if (method === 'disconnect') {
    remotePeer?.close();
    remotePeer = null;
    remoteState = null;
    fs.rmSync(path.join(dataDir, 'paired-remote.enc'), { force: true });
    publish();
    return {};
  }
  if (method === 'revoke') {
    hostPeer?.revoke();
    hostPeer = null;
    publish();
    return { message: 'Pairing revoked. Other devices can no longer access this desktop.' };
  }
  if (method === 'pair') {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error('Enable your operating system keychain before pairing.');
    hostPeer ??= new HostPeer({
      directory: dataDir,
      encrypt: (v) => safeStorage.encryptString(v),
      decrypt: (v) => safeStorage.decryptString(v),
      state: () => queue.snapshot(),
      command: perform,
    });
    if (remotePeer) throw new Error('Disconnect the companion before hosting another desktop.');
    const code = await hostPeer.start(input.host);
    clipboard.writeText(code);
    publish();
    return { message: 'Pairing code copied. Paste it into Work Updates on your Mac.' };
  }
  if (method === 'connect') {
    if (hostPeer?.server)
      throw new Error('Revoke hosted pairing before connecting to another desktop.');
    if (!safeStorage.isEncryptionAvailable())
      throw new Error('Enable your operating system keychain before pairing.');
    remotePeer?.close();
    const peer = new RemotePeer(input.code);
    remotePeer = peer;
    remoteState = null;
    previousRemote = null;
    peer.on('state', (value) => {
      remoteState = value;
      previousRemote = incoming(value.cards, previousRemote);
      publish();
    });
    peer.on('connection', () => publish());
    try {
      await peer.connect();
      fs.writeFileSync(
        path.join(dataDir, 'paired-remote.enc'),
        safeStorage.encryptString(input.code),
        { mode: 0o600 },
      );
    } catch (error) {
      if (input.restore) {
        peer.reconnect();
      } else {
        peer.close();
        remotePeer = null;
        remoteState = null;
        publish();
        throw error;
      }
    }
    publish();
    return { message: 'Connected to your desktop.' };
  }
}
app.whenReady().then(async () => {
  protocol.handle('work-updates', (request) => {
    const url = new URL(request.url);
    const files = {
      '/index.html': ['index.html', 'text/html'],
      '/corner.html': ['corner.html', 'text/html'],
      '/weather.html': ['weather.html', 'text/html'],
      '/weather.js': ['weather.js', 'text/javascript'],
      '/weather.css': ['weather.css', 'text/css'],
      '/app.js': ['app.js', 'text/javascript'],
      '/style.css': ['style.css', 'text/css'],
      '/icon.svg': ['../assets/icon.svg', 'image/svg+xml'],
    };
    const entry = files[url.pathname];
    if (url.hostname !== 'app' || !entry) return new Response('Not found', { status: 404 });
    return new Response(fs.readFileSync(path.join(__dirname, 'ui', entry[0])), {
      headers: {
        'Content-Type': entry[1],
        'Content-Security-Policy': csp,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    });
  });
  const saved = queue.state.settings.bounds || {},
    area = screen.getPrimaryDisplay().workArea,
    queueWidth = 420,
    queueHeight = Math.min(880, area.height - 32),
    initiallyVisible = startsVisible(args, demo);
  window = new BrowserWindow({
    width: queueWidth,
    height: queueHeight,
    minWidth: 390,
    minHeight: 590,
    x: Math.max(
      area.x,
      Math.min(saved.x ?? area.x + area.width - queueWidth - 24, area.x + area.width - queueWidth),
    ),
    y: Math.max(area.y, Math.min(saved.y ?? area.y + 24, area.y + area.height - queueHeight)),
    frame: false,
    transparent: true,
    show: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    title: 'Work Updates',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  windowController = new WindowController({
    window,
    visible: false,
    present: (visible) => {
      clearTimeout(concealTimer);
      window.setIgnoreMouseEvents(!visible);
      if (visible) {
        configureWindowLevel();
        if (!window.isVisible()) window.showInactive();
        if (windowController.mode === 'pinned') window.moveTop();
      } else
        concealTimer = setTimeout(() => {
          if (!window.isDestroyed() && windowController.mode === 'hidden') {
            // Windows can keep an inactive layered window as foreground after
            // blur(). Release it only once the exit has painted zero alpha.
            const focused = window.isFocused();
            if (focused) window.hide();
            window.setFocusable(false);
            configureWindowLevel();
            if (focused) window.showInactive();
          }
        }, 260);
    },
    launcher: () => corner?.getBounds(),
    workArea: (bounds) => screen.getDisplayMatching(bounds).workArea,
    saveBounds: (bounds) => {
      queue.state.settings.bounds = bounds;
    },
  });
  windowController.onChange = publish;
  window.once('ready-to-show', () => {
    window.setIgnoreMouseEvents(true);
    window.showInactive();
    if (initiallyVisible || windowController.mode === 'pinned') show();
  });
  window.webContents.on('will-navigate', (e) => e.preventDefault());
  window.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      windowController.hide();
    }
  });
  for (const method of [
    'state',
    'create',
    'start',
    'action',
    'undo',
    'send',
    'stop',
    'respond',
    'details',
    'group',
    'refresh',
    'open',
    'project',
    'settings',
    'window',
    'pair',
    'connect',
    'disconnect',
    'revoke',
    'updates',
  ])
    ipcMain.handle('work-updates:' + method, async (event, input) => {
      if (!event.senderFrame?.url.startsWith('work-updates://app/'))
        return { ok: false, error: 'Unknown app frame.' };
      try {
        return { ok: true, value: await perform(method, input || {}) };
      } catch (error) {
        return { ok: false, error: error.message, taskId: error.taskId };
      }
    });
  if (process.platform === 'darwin') app.dock?.hide();
  tray = createTray({
    Tray,
    Menu,
    nativeImage,
    nativeTheme,
    assets: path.join(__dirname, 'assets'),
    platform: process.platform,
    demo,
    show,
    hide: () => windowController.hide(),
    create: () => perform('window', { action: 'new' }),
    quit: () => {
      quitting = true;
      app.quit();
    },
  });
  tray.update(snapshot());
  if (argument('--legacy-root')) queue.importLegacy(path.resolve(argument('--legacy-root')));
  if (demo) queue.setFeed(require('./src/demo.cjs').feed());
  else {
    const helper = app.isPackaged
      ? path.join(
          process.resourcesPath,
          'helper',
          process.platform === 'win32' ? 'collector.exe' : 'collector',
        )
      : undefined;
    const helperScript = app.isPackaged
      ? path.join(process.resourcesPath, 'helper', 'collector.py')
      : undefined;
    observer = startObserver(
      path.join(dataDir, 'observer'),
      { helper, helperScript },
      (feed, health) => {
        queue.setFeed(feed || queue.feed, health);
        previousObserved = incoming(
          queue.cards().filter((c) => c.kind === 'observed'),
          previousObserved,
        );
      },
    );
  }
  configure();
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed'])
    screen.on(event, refreshCorner);
  await window.loadURL('work-updates://app/index.html');
  const runtime = () =>
    atomic(path.join(dataDir, 'runtime.json'), {
      appPid: process.pid,
      collectorPid: observer?.pid || null,
      chats: queue.feed.monitoredCount || 0,
      feedCollectedAt: queue.feed.collectedAt || 0,
      visible: windowController.mode !== 'hidden',
      windowMode: windowController.mode,
      cornerEnabled: !!queue.state.settings.corner,
      launcher: { ...launcherInfo, active: !!corner && !corner.isDestroyed() },
      tray: tray.status(),
      updatedAt: now(),
    });
  runtime();
  const runtimeTimer = setInterval(runtime, 3000);
  runtimeTimer.unref();
  if (!demo && safeStorage.isEncryptionAvailable()) {
    const { HostPeer } = require('./src/peer.cjs');
    hostPeer = new HostPeer({
      directory: dataDir,
      encrypt: (v) => safeStorage.encryptString(v),
      decrypt: (v) => safeStorage.decryptString(v),
      state: () => queue.snapshot(),
      command: perform,
    });
    if (hostPeer.saved())
      hostPeer
        .restore()
        .then(publish)
        .catch(() => {});
    try {
      const code = safeStorage.decryptString(
        fs.readFileSync(path.join(dataDir, 'paired-remote.enc')),
      );
      connectionAction('connect', { code, restore: true }).catch(() => {});
    } catch {}
  }
  if (args.includes('--dev')) {
    let refresh;
    fs.watch(path.join(__dirname, 'ui'), () => {
      clearTimeout(refresh);
      refresh = setTimeout(() => window.webContents.reload(), 250);
    });
  }
  if (argument('--snapshot'))
    setTimeout(async () => {
      const image = await window.webContents.capturePage();
      fs.writeFileSync(path.resolve(argument('--snapshot')), image.toPNG());
    }, 4500);
  if (args.includes('--smoke'))
    setTimeout(async () => {
      try {
        await window.webContents.executeJavaScript('document.getElementById("new-task").click()');
        const ok = await window.webContents.executeJavaScript(
          'document.querySelector("#task-prompt") !== null',
        );
        if (!ok) throw new Error('Composer did not open');
        process.stdout.write('Desktop smoke check passed\n');
        quitting = true;
        app.exit(0);
      } catch {
        app.exit(1);
      }
    }, 1300);
});
app.on('activate', () => window && show());
app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  quitting = true;
  queue.save();
  observer?.close();
  client.close();
  hostPeer?.close();
  remotePeer?.close();
  globalShortcut.unregisterAll();
  clearInterval(cornerTimer);
  clearTimeout(concealTimer);
  tray?.destroy();
});
