'use strict';
const inside = (point, rect, margin = 0) =>
  rect &&
  point.x >= rect.x - margin &&
  point.x < rect.x + rect.width + margin &&
  point.y >= rect.y - margin &&
  point.y < rect.y + rect.height + margin;

class WindowController {
  constructor({ window, launcher, workArea, saveBounds, present, visible = window.isVisible() }) {
    this.window = window;
    this.launcher = launcher;
    this.workArea = workArea;
    this.saveBounds = saveBounds;
    this.present = present || ((visible) => (visible ? window.showInactive() : window.hide()));
    this.mode = visible ? 'pinned' : 'hidden';
    this.floating = window.getBounds();
    this.enabled = false;
    this.enteredAt = null;
    this.leftAt = null;
    this.suppressed = false;
    this.onCorner = false;
    this.onChange = () => {};
    window.on('focus', () => this.retain());
    window.on('will-move', () => this.retain());
    window.on('move', () => {
      if (this.mode === 'pinned') this.remember();
    });
    window.on('resize', () => {
      if (this.mode === 'pinned') this.remember();
    });
  }
  setMode(mode) {
    this.mode = mode;
    this.onChange(mode);
  }
  remember() {
    this.floating = this.window.getBounds();
    this.saveBounds(this.floating);
  }
  enable(enabled) {
    this.enabled = enabled;
    this.enteredAt = this.leftAt = null;
    if (!enabled && this.mode === 'peek') this.hide();
  }
  peek() {
    if (!this.enabled || this.mode !== 'hidden' || this.suppressed) return;
    if (this.window.isFocused?.()) this.window.blur();
    if (this.window.isFocusable?.() !== false) this.window.setFocusable(false);
    const launcher = this.launcher(),
      area = this.workArea(launcher);
    const bounds = this.window.getBounds();
    this.window.setPosition(
      Math.max(area.x, Math.min(launcher.x - 8, area.x + area.width - bounds.width)),
      Math.max(area.y, launcher.y - bounds.height - 6),
    );
    this.setMode('peek');
    this.present(true);
    this.leftAt = null;
  }
  retain() {
    if (this.mode !== 'peek') return;
    this.setMode('pinned');
    this.window.setFocusable(true);
    this.window.focus();
    this.present(true);
    this.remember();
    this.enteredAt = this.leftAt = null;
  }
  show() {
    this.window.setFocusable(true);
    if (this.mode === 'hidden') {
      const area = this.workArea(this.floating);
      this.window.setPosition(
        Math.max(area.x, Math.min(this.floating.x, area.x + area.width - this.floating.width)),
        Math.max(area.y, Math.min(this.floating.y, area.y + area.height - this.floating.height)),
      );
    }
    this.setMode('pinned');
    this.present(true);
    this.window.focus();
    this.remember();
  }
  hide(suppress = this.onCorner) {
    if (this.mode === 'pinned') this.remember();
    this.setMode('hidden');
    this.present(false);
    this.enteredAt = this.leftAt = null;
    // A click while hovering must stay hidden until the pointer leaves the launcher.
    this.suppressed = suppress;
  }
  toggle() {
    this.mode === 'hidden' ? this.show() : this.hide();
  }
  clickCorner() {
    if (this.mode === 'peek') {
      this.retain();
      this.window.focus();
    } else if (this.mode === 'hidden') this.show();
    else this.hide(true);
  }
  tick(point, at = Date.now()) {
    if (!this.enabled) return;
    const onCorner = inside(point, this.launcher());
    this.onCorner = !!onCorner;
    if (!onCorner) {
      this.suppressed = false;
      this.enteredAt = null;
    }
    if (this.mode === 'hidden') {
      if (!onCorner || this.suppressed) return;
      this.enteredAt ??= at;
      if (at - this.enteredAt >= 220) this.peek();
    } else if (this.mode === 'peek') {
      if (onCorner || inside(point, this.window.getBounds(), 6)) this.leftAt = null;
      else {
        this.leftAt ??= at;
        if (at - this.leftAt >= 400) this.hide();
      }
    }
  }
}
module.exports = { WindowController };
