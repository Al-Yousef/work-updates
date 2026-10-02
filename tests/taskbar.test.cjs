'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLayout, weatherTarget } = require('../src/taskbar.cjs');
const display = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1032 },
};
const supported = { centered: true, widgets: true };

test('reads Widgets and icon alignment without relying on localized registry headings', () => {
  assert.deepEqual(
    parseLayout('TaskbarAl    REG_DWORD    0x1\nTaskbarDa REG_DWORD 0x1'),
    supported,
  );
  assert.deepEqual(parseLayout('TaskbarAl REG_DWORD 0x0\nTaskbarDa REG_DWORD 0x1'), {
    centered: false,
    widgets: true,
  });
  assert.equal(parseLayout('TaskbarDa REG_DWORD 0x1').centered, true);
  assert.equal(parseLayout('').widgets, false);
});

test('input region stays entirely in the taskbar strip and uses display DIP coordinates', () => {
  assert.deepEqual(weatherTarget(display, supported).bounds, {
    x: 0,
    y: 1032,
    width: 144,
    height: 48,
  });
  const shifted = {
    bounds: { x: -1920, y: -120, width: 1536, height: 864 },
    workArea: { x: -1920, y: -120, width: 1536, height: 816 },
    scaleFactor: 1.25,
  };
  assert.deepEqual(weatherTarget(shifted, supported).bounds, {
    x: -1920,
    y: 696,
    width: 144,
    height: 48,
  });
});

test('disabled Widgets or left aligned icons never produce a region over Start', () => {
  assert.equal(weatherTarget(display, { ...supported, widgets: false }).bounds, null);
  assert.equal(weatherTarget(display, { ...supported, centered: false }).bounds, null);
});

test('auto-hidden, side, top and unknown taskbars never cover application content', () => {
  for (const workArea of [
    { x: 0, y: 0, width: 1920, height: 1078 },
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: 48, y: 0, width: 1872, height: 1080 },
    { x: 0, y: 48, width: 1920, height: 1032 },
    { x: 0, y: 0, width: 1920, height: 800 },
  ])
    assert.equal(weatherTarget({ ...display, workArea }, supported).bounds, null);
});
