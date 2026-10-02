'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { WindowController } = require('../src/window-controller.cjs');

function fixture() {
  class Window extends EventEmitter {
    constructor() {
      super();
      this.visible = false;
      this.focused = false;
      this.focusable = false;
      this.skipTaskbar = true;
      this.focusChanges = 0;
      this.bounds = { x: 850, y: 40, width: 484, height: 720 };
    }
    isVisible() {
      return this.visible;
    }
    getBounds() {
      return { ...this.bounds };
    }
    setPosition(x, y) {
      Object.assign(this.bounds, { x, y });
      this.emit('move');
    }
    showInactive() {
      this.visible = true;
    }
    setFocusable(value) {
      this.focusable = value;
      this.skipTaskbar = !value;
      this.focusChanges++;
      if (!value) this.focused = false;
    }
    isFocusable() {
      return this.focusable;
    }
    setSkipTaskbar(value) {
      this.skipTaskbar = value;
    }
    show() {
      this.visible = true;
      this.focus();
    }
    focus() {
      this.focused = true;
      this.emit('focus');
    }
    hide() {
      this.visible = this.focused = false;
    }
  }
  const window = new Window(),
    saved = [],
    launcher = { x: 12, y: 1000, width: 44, height: 44 };
  const controller = new WindowController({
    window,
    launcher: () => launcher,
    workArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    saveBounds: (b) => saved.push(b),
  });
  controller.enable(true);
  const enter = (at) => {
    controller.tick({ x: 25, y: 1020 }, at);
    controller.tick({ x: 25, y: 1020 }, at + 220);
  };
  return { window, controller, saved, enter };
}
test('brief corner transit stays hidden; a hover opens without stealing focus', () => {
  const f = fixture();
  f.controller.tick({ x: 25, y: 1020 }, 0);
  f.controller.tick({ x: 300, y: 900 }, 180);
  assert.equal(f.window.visible, false);
  f.enter(500);
  assert.equal(f.controller.mode, 'peek');
  assert.equal(f.window.visible, true);
  assert.equal(f.window.focused, false);
  assert.equal(f.saved.length, 0);
});

test('granting focus preserves tray-only taskbar behavior and repeated opens do not reset it', () => {
  const f = fixture();
  f.controller.show();
  assert.equal(f.window.focusable, true);
  assert.equal(f.window.skipTaskbar, true);
  f.controller.show();
  assert.equal(f.window.focusChanges, 1);
  f.controller.hide();
  f.enter(500);
  assert.equal(f.window.focusable, false);
  f.controller.retain();
  assert.equal(f.window.focusable, true);
  assert.equal(f.window.skipTaskbar, true);
});
test('crossing the gap and entering the queue keeps a peek open; leaving closes it', () => {
  const f = fixture();
  f.enter(0);
  f.controller.tick({ x: 30, y: 985 }, 300);
  f.controller.tick({ x: 100, y: 500 }, 600);
  f.controller.tick({ x: 100, y: 500 }, 1200);
  assert.equal(f.controller.mode, 'peek');
  f.controller.tick({ x: 1500, y: 500 }, 1400);
  f.controller.tick({ x: 1500, y: 500 }, 1800);
  assert.equal(f.controller.mode, 'hidden');
  assert.equal(f.window.visible, false);
});
test('clicking a peek keeps it open, and a second corner click hides without reopening', () => {
  const f = fixture();
  f.enter(0);
  f.controller.clickCorner();
  assert.equal(f.controller.mode, 'pinned');
  assert.equal(f.window.focused, true);
  f.controller.tick({ x: 1500, y: 500 }, 1000);
  assert.equal(f.window.visible, true);
  f.controller.clickCorner();
  f.enter(2000);
  assert.equal(f.controller.mode, 'hidden');
  f.controller.tick({ x: 1500, y: 500 }, 2400);
  f.enter(2600);
  assert.equal(f.controller.mode, 'peek');
});
test('clicking inside or dragging a peek retains it and remembers the floating location', () => {
  for (const event of ['focus', 'will-move']) {
    const f = fixture();
    f.enter(0);
    f.window.emit(event);
    f.window.setPosition(600, 100);
    f.controller.hide();
    f.controller.clickCorner();
    assert.equal(f.controller.mode, 'pinned');
    assert.deepEqual(f.window.getBounds(), { x: 600, y: 100, width: 484, height: 720 });
  }
});
test('a temporary peek never overwrites the previous floating position', () => {
  const f = fixture();
  f.enter(0);
  f.controller.hide();
  f.controller.clickCorner();
  assert.deepEqual(f.window.getBounds(), { x: 850, y: 40, width: 484, height: 720 });
});
test('disabling the launcher closes only a temporary peek', () => {
  const f = fixture();
  f.enter(0);
  f.controller.enable(false);
  assert.equal(f.window.visible, false);
  f.controller.show();
  f.controller.enable(false);
  assert.equal(f.window.visible, true);
});
test('hiding away from the launcher allows the next hover without an extra exit', () => {
  const f = fixture();
  f.controller.show();
  f.controller.tick({ x: 900, y: 100 }, 0);
  f.controller.hide();
  f.enter(1000);
  assert.equal(f.controller.mode, 'peek');
});
