'use strict';
const fs = require('node:fs');
const { atomicJson } = require('./policy.cjs');
function clamp(rect, area) {
  const width = Math.min(Math.max(76, rect.width), area.width);
  const height = Math.min(Math.max(76, rect.height), area.height);
  return {
    x: Math.round(Math.min(Math.max(rect.x, area.x), area.x + area.width - width)),
    y: Math.round(Math.min(Math.max(rect.y, area.y), area.y + area.height - height)),
    width,
    height,
  };
}
class ReviewWindow {
  constructor(window, screen, file, { auditHidden = false } = {}) {
    this.window = window;
    this.screen = screen;
    this.file = file;
    this.auditHidden = auditHidden;
    this.expanded = false;
    this.changing = false;
    this.focusRequests = 0;
    try {
      this.saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      this.saved = {};
    }
    const area = screen.getPrimaryDisplay().workArea;
    this.dot = this.valid(this.saved.dot)
      ? this.saved.dot
      : { x: area.x + 24, y: area.y + area.height - 100, width: 76, height: 76 };
    this.panel = this.valid(this.saved.panel) ? this.saved.panel : null;
    window.on('move', () => this.remember());
    window.on('resize', () => this.remember());
    this.apply(false, false, true);
  }
  valid(rect) {
    return rect && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(rect[k]));
  }
  remember() {
    if (this.changing || this.window.isDestroyed()) return;
    const rect = this.window.getBounds();
    if (this.expanded) {
      this.panel = rect;
      this.dot = { x: rect.x, y: rect.y + rect.height - 76, width: 76, height: 76 };
    } else {
      const dx = rect.x - this.dot.x,
        dy = rect.y - this.dot.y;
      if (this.panel) this.panel = { ...this.panel, x: this.panel.x + dx, y: this.panel.y + dy };
      this.dot = { ...rect, width: 76, height: 76 };
    }
    atomicJson(this.file, { version: 1, dot: this.dot, panel: this.panel });
  }
  apply(expanded, userInitiated = false, force = false) {
    if (typeof expanded !== 'boolean' || typeof userInitiated !== 'boolean')
      throw new Error('Invalid window intent.');
    if (expanded !== this.expanded || force) {
      if (!force) this.remember();
      const area = this.screen.getDisplayMatching(this.dot).workArea;
      const height = Math.min(820, area.height - 24);
      const target = expanded
        ? this.panel || {
            x: this.dot.x,
            y: this.dot.y + 76 - height,
            width: Math.min(440, area.width),
            height,
          }
        : { ...this.dot, width: 76, height: 76 };
      this.changing = true;
      this.expanded = expanded;
      this.window.setFocusable(expanded && !this.auditHidden);
      this.window.setSkipTaskbar(true);
      this.window.setBounds(clamp(target, area));
      this.changing = false;
      this.remember();
    }
    // Only an explicit open may request foreground, never recovery or polling.
    if (expanded && userInitiated && !this.auditHidden) {
      this.focusRequests++;
      this.window.focus();
    }
    if (!expanded && !this.auditHidden && this.window.isFocused()) this.window.blur();
    return this.state();
  }
  present() {
    if (!this.auditHidden) this.window.showInactive();
  }
  state() {
    return {
      expanded: this.expanded,
      bounds: this.window.getBounds(),
      visible: this.window.isVisible(),
      focused: this.window.isFocused(),
      focusRequests: this.focusRequests,
      auditHidden: this.auditHidden,
    };
  }
}
module.exports = { ReviewWindow, clamp };
