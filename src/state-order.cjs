'use strict';
const { randomUUID } = require('node:crypto');
const validEpoch = (value) =>
  typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
class StatePublisher {
  constructor({ clock = Date.now } = {}) {
    this.clock = clock;
    this.epoch = randomUUID();
    this.revision = 0;
  }
  stamp(state) {
    if (this.revision === Number.MAX_SAFE_INTEGER) {
      this.epoch = randomUUID();
      this.revision = 0;
    }
    // Called synchronously with snapshot creation. Revisions order HTTP and SSE
    // even when their delivery is delayed, the clock changes, or content is equal.
    return {
      ...state,
      protocolVersion: 3,
      servedAt: Math.floor(this.clock() / 1000),
      stateVersion: { epoch: this.epoch, revision: ++this.revision },
    };
  }
}
class StateOrder {
  constructor({ required = false } = {}) {
    this.required = required;
    this.current = null;
  }
  reset() {
    this.current = null;
  }
  accept(version) {
    if (version == null) {
      if (this.required || this.current)
        throw new Error('Update the paired desktop to support ordered queue updates.');
      return true;
    }
    if (
      !validEpoch(version.epoch) ||
      !Number.isSafeInteger(version.revision) ||
      version.revision < 1
    )
      throw new Error('The paired desktop returned an invalid state version.');
    if (this.current && version.epoch !== this.current.epoch)
      throw Object.assign(
        new Error('The paired desktop restarted. Reconnecting to its current queue.'),
        { code: 'STATE_RESTARTED' },
      );
    if (this.current && version.revision <= this.current.revision) return false;
    this.current = { epoch: version.epoch, revision: version.revision };
    return true;
  }
}
module.exports = { StatePublisher, StateOrder };
