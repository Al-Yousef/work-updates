'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { createTray, tooltip, TRAY_GUID } = require('../src/tray.cjs');
const { dataDirectory, startsVisible } = require('../src/background.cjs');

test('production stays concealed without depending on weather, while explicit show and demo work', () => {
  assert.equal(startsVisible([]), false);
  assert.equal(startsVisible(['--show']), true);
  assert.equal(startsVisible(['--hidden', '--show']), false);
  assert.equal(startsVisible([], true), true);
  assert.equal(startsVisible(['--hidden'], true), false);
});

test('portable direct launches share the launcher queue; demos and generic installs stay isolated', () => {
  const root = path.resolve('portable'),
    executable = path.join(root, 'desktop', 'Work Updates.exe');
  const files = new Set([
    path.join(root, 'Work Updates.exe'),
    path.join(root, 'data', 'desktop', 'state.json'),
  ]);
  const input = {
    platform: 'win32',
    packaged: true,
    executable,
    fallback: 'default-data',
    isFile: (f) => files.has(f),
  };
  assert.equal(dataDirectory(input), path.join(root, 'data', 'desktop'));
  assert.equal(dataDirectory({ ...input, explicit: 'test-data' }), path.resolve('test-data'));
  assert.equal(dataDirectory({ ...input, isFile: () => false }), 'default-data');
  assert.equal(dataDirectory({ ...input, platform: 'darwin' }), 'default-data');
  assert.equal(dataDirectory({ ...input, packaged: false }), 'default-data');
});

test('tray counts use actionable queue cards, identify waiting ownership and exclude muted updates', () => {
  assert.equal(tooltip({ cards: [] }), 'Work Updates\nMonitoring your chats');
  assert.equal(
    tooltip({
      cards: [
        { status: 'needs' },
        { status: 'waiting', waitingOn: { kind: 'you' } },
        { status: 'working' },
        { status: 'starting' },
        { status: 'ready' },
        { status: 'ready', reviewed: true },
        { status: 'needs', snoozed: true },
        { status: 'ready', done: true },
        { status: 'waiting', waitingOn: { kind: 'other' } },
      ],
    }),
    'Work Updates\n2 waiting on you · 2 working · 1 ready to review',
  );
});

function fixture(platform = 'win32', demo = false) {
  let instance;
  class FakeTray extends EventEmitter {
    constructor(image, guid) {
      super();
      this.argumentCount = arguments.length;
      this.image = image;
      this.guid = guid;
      this.menus = 0;
      instance = this;
    }
    setContextMenu(menu) {
      this.menu = menu;
      this.menus++;
    }
    setToolTip(text) {
      this.tooltip = text;
    }
    setImage(image) {
      this.image = image;
    }
    isDestroyed() {
      return !!this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
    getGUID() {
      return this.guid;
    }
    getBounds() {
      return { x: 1, y: 1, width: 16, height: 16 };
    }
  }
  const nativeTheme = new EventEmitter();
  nativeTheme.shouldUseDarkColorsForSystemIntegratedUI = true;
  const actions = [];
  const manager = createTray({
    Tray: FakeTray,
    Menu: { buildFromTemplate: (items) => items },
    nativeImage: {
      createFromPath: (file) => ({
        file,
        representations: [],
        addRepresentation(r) {
          this.representations.push(r);
        },
        setTemplateImage(v) {
          this.template = v;
        },
      }),
    },
    nativeTheme,
    assets: path.resolve(__dirname, '../assets'),
    platform,
    demo,
    show: () => actions.push('show'),
    hide: () => actions.push('hide'),
    create: () => actions.push('create'),
    quit: () => actions.push('quit'),
  });
  return { manager, tray: instance, nativeTheme, actions };
}

test('native tray actions open idempotently, hide explicitly and remain stable on heartbeats', () => {
  const f = fixture();
  f.manager.update({ windowMode: 'hidden', cards: [] });
  assert.equal(f.tray.guid, TRAY_GUID);
  assert.equal(f.tray.menu.find((i) => i.label === 'Hide queue').enabled, false);
  f.tray.emit('click');
  f.tray.emit('double-click');
  f.tray.emit('click');
  assert.deepEqual(f.actions, ['show', 'show', 'show']);
  f.manager.update({ windowMode: 'pinned', cards: [] });
  assert.equal(f.tray.menu.find((i) => i.label === 'Hide queue').enabled, true);
  f.manager.update({ windowMode: 'pinned', cards: [] });
  assert.equal(f.tray.menus, 2);
  for (const label of ['Open queue', 'Hide queue', 'New task', 'Quit Work Updates'])
    f.tray.menu.find((i) => i.label === label).click();
  assert.deepEqual(f.actions.slice(3), ['show', 'hide', 'create', 'quit']);
  f.manager.destroy();
  assert.equal(f.tray.destroyed, true);
  assert.equal(f.nativeTheme.listenerCount('updated'), 0);
});

test('tray responds to system theme changes and Mac uses a template with independent demo identity', () => {
  const f = fixture();
  assert.ok(f.tray.image.file.endsWith('tray-light.png'));
  assert.deepEqual(
    f.tray.image.representations.map((r) => r.scaleFactor),
    [2, 3],
  );
  f.nativeTheme.shouldUseDarkColorsForSystemIntegratedUI = false;
  f.nativeTheme.emit('updated');
  assert.ok(f.tray.image.file.endsWith('tray-dark.png'));
  const mac = fixture('darwin');
  assert.equal(mac.tray.image.template, true);
  assert.equal(mac.tray.listenerCount('click'), 0);
  const demo = fixture('win32', true);
  assert.equal(demo.tray.guid, undefined);
  assert.equal(demo.tray.argumentCount, 1);
  demo.manager.destroy();
  f.manager.destroy();
  mac.manager.destroy();
});
