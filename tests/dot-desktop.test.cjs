'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { InboxModel } = require('../candidate/dot-inbox/model.js');
const {
  privateRoot,
  prepare,
  recoveryRecord,
  atomicJson,
  owns,
  route,
  ORIGIN,
} = require('../candidate/dot-inbox/desktop/policy.cjs');
const { ReviewWindow, clamp } = require('../candidate/dot-inbox/desktop/window.cjs');
const { startPreview } = require('../candidate/dot-inbox/server.cjs');
function directory(t) {
  const parent = path.resolve(__dirname, '../artifacts/dot-inbox/desktop-tests');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'dot-review-tests-'));
  t.after(() => {
    const target = fs.realpathSync(root);
    if (
      target.startsWith(fs.realpathSync(parent) + path.sep) &&
      path.basename(target).startsWith('dot-review-tests-')
    )
      fs.rmSync(target, { recursive: true, force: true });
  });
  return root;
}
test('review data root rejects installed/outside paths, traversal and junctions', (t) => {
  const root = directory(t),
    allowed = path.join(root, 'review'),
    other = path.join(root, 'installed');
  fs.mkdirSync(allowed);
  fs.mkdirSync(other);
  assert.throws(() => privateRoot(allowed, other));
  assert.throws(() => privateRoot(allowed, path.join(allowed, '..', 'installed')));
  fs.symlinkSync(
    other,
    path.join(allowed, 'redirect'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.throws(() => privateRoot(allowed, path.join(allowed, 'redirect', 'data')));
  assert.throws(() =>
    privateRoot(path.join(allowed, 'redirect'), path.join(allowed, 'redirect', 'data')),
  );
  assert.equal(
    privateRoot(allowed, path.join(allowed, 'own')),
    fs.realpathSync(path.join(allowed, 'own')),
  );
});
test('recovery copy is minimal, bound, copied once and never overwrites review records', (t) => {
  const root = directory(t),
    seed = path.join(root, 'seed'),
    data = path.join(root, 'data');
  fs.mkdirSync(seed);
  fs.mkdirSync(data);
  const model = new InboxModel();
  const card = {
    owner: { id: 'sample-pc' },
    id: 'task',
    taskKey: 'task-revision',
    contextRevision: 'context',
    primarySourceId: 'chat',
    sources: [{ id: 'chat' }],
  };
  model.open(card, 'chat');
  model.draft('Retained draft');
  const record = model.export();
  record.sourceLog = 'must not copy';
  record.selection.body = 'must not copy';
  atomicJson(path.join(seed, 'client-recovery.json'), record);
  atomicJson(path.join(seed, 'recovery.json'), { version: 1, events: [] });
  const store = prepare(data, seed);
  const saved = JSON.parse(fs.readFileSync(store.client, 'utf8'));
  assert.equal(saved.drafts[0][1], 'Retained draft');
  assert.equal(saved.sourceLog, undefined);
  assert.equal(saved.selection.body, undefined);
  const changed = { ...saved, opened: false };
  atomicJson(store.client, changed);
  assert.deepEqual(JSON.parse(fs.readFileSync(prepare(data, seed).client, 'utf8')), changed);
  const bad = structuredClone(saved);
  bad.bindings[0][1].sourceId = 'somebody-else';
  assert.throws(() => recoveryRecord(JSON.stringify(bad)));
});
test('corrupt recovery remains intact, and redirected user-data is rejected', (t) => {
  const root = directory(t),
    data = path.join(root, 'data'),
    other = path.join(root, 'other');
  fs.mkdirSync(data);
  fs.mkdirSync(other);
  fs.symlinkSync(
    other,
    path.join(data, 'user-data'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.throws(() => prepare(data));
  fs.writeFileSync(path.join(other, 'broken.json'), '{broken');
  assert.throws(() => recoveryRecord(fs.readFileSync(path.join(other, 'broken.json'), 'utf8')));
  assert.equal(fs.readFileSync(path.join(other, 'broken.json'), 'utf8'), '{broken');
});
test('IPC belongs only to the exact owned top-level review frame', () => {
  const frame = { url: ORIGIN + '/' },
    webContents = { mainFrame: frame },
    window = { isDestroyed: () => false, webContents };
  assert.equal(owns({ sender: webContents, senderFrame: frame }, window), true);
  assert.equal(owns({ sender: {}, senderFrame: frame }, window), false);
  assert.equal(owns({ sender: webContents, senderFrame: { url: frame.url } }, window), false);
  frame.url = 'https://example.invalid/';
  assert.equal(owns({ sender: webContents, senderFrame: frame }, window), false);
});
test('desktop protocol rejects arbitrary paths, hosts, origins and action headers', () => {
  const request = (pathname, options = {}) => ({
    url: ORIGIN + pathname,
    method: 'GET',
    headers: new Headers(),
    ...options,
  });
  assert.equal(route(request('/api/state')), '/api/state');
  assert.throws(() => route(request('/main.cjs')));
  assert.throws(() =>
    route(request('/api/state', { url: 'work-updates-review://other/api/state' })),
  );
  assert.throws(() => route(request('/api/state', { initiatorOrigin: 'https://example.invalid' })));
  assert.throws(() => route(request('/api/action', { method: 'POST' })));
  assert.equal(
    route(
      request('/api/action', {
        method: 'POST',
        initiatorOrigin: ORIGIN,
        headers: new Headers({ 'X-Dot-Preview': 'fixture' }),
      }),
    ),
    '/api/action',
  );
});
class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.bounds = { x: 0, y: 0, width: 76, height: 76 };
    this.calls = [];
  }
  isDestroyed() {
    return false;
  }
  getBounds() {
    return this.bounds;
  }
  setBounds(value) {
    this.bounds = value;
    this.emit('move');
    this.emit('resize');
  }
  setFocusable(value) {
    this.calls.push(['focusable', value]);
  }
  setSkipTaskbar(value) {
    this.calls.push(['skip', value]);
  }
  focus() {
    this.calls.push(['focus']);
  }
  blur() {
    this.calls.push(['blur']);
  }
  showInactive() {
    this.calls.push(['inactive']);
  }
  isVisible() {
    return false;
  }
  isFocused() {
    return false;
  }
}
const area = { x: -1280, y: 0, width: 1280, height: 720 };
const screens = {
  getPrimaryDisplay: () => ({ workArea: area }),
  getDisplayMatching: () => ({ workArea: area }),
};
test('startup, recovery and polling never request focus; only explicit open does', (t) => {
  const window = new FakeWindow(),
    controller = new ReviewWindow(window, screens, path.join(directory(t), 'placement.json'));
  controller.present();
  controller.apply(true);
  controller.apply(true);
  controller.apply(false);
  assert.equal(window.calls.filter((c) => c[0] === 'focus').length, 0);
  controller.apply(true, true);
  assert.equal(window.calls.filter((c) => c[0] === 'focus').length, 1);
  assert.deepEqual(window.calls.slice(-3), [['focusable', true], ['skip', true], ['focus']]);
  assert.throws(() => controller.apply('open'));
});
test('hidden audit suppresses all display/focus and restores clamped drag placement', (t) => {
  const file = path.join(directory(t), 'placement.json'),
    window = new FakeWindow();
  const controller = new ReviewWindow(window, screens, file, { auditHidden: true });
  controller.present();
  controller.apply(true, true);
  window.setBounds({ x: -1000, y: 24, width: 440, height: 696 });
  controller.apply(false);
  assert.equal(window.bounds.x, -1000);
  assert.equal(window.bounds.y, 644);
  assert.equal(
    window.calls.some((c) => ['focus', 'inactive'].includes(c[0])),
    false,
  );
  const again = new ReviewWindow(new FakeWindow(), screens, file, { auditHidden: true });
  assert.deepEqual(again.dot, controller.dot);
  again.apply(true);
  assert.deepEqual(again.window.getBounds(), { x: -1000, y: 24, width: 440, height: 696 });
  assert.deepEqual(clamp({ x: 99999, y: -99999, width: 440, height: 820 }, area), {
    x: -440,
    y: 0,
    width: 440,
    height: 720,
  });
});
test('packaged session directory and receipts stay in the selected private review root', async (t) => {
  const root = directory(t),
    sessionRoot = path.join(root, 'sessions');
  const preview = await startPreview({
    sessionsRoot: sessionRoot,
    recoveryRoot: path.join(root, 'receipts'),
  });
  assert.ok(preview.directory.startsWith(sessionRoot + path.sep));
  preview.choose('active');
  assert.equal(preview.snapshot().preview.commands.length, 0);
  await preview.close();
  assert.equal(fs.existsSync(preview.directory), false);
});
