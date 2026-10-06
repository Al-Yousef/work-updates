'use strict';
const { NotificationFlow } = require('./notification-flow.cjs');
const { StatePublisher } = require('./state-order.cjs');
// Observe the existing Devices facade *after* its per-computer ordering checks.
// This session is opt-in; the installed app and main.cjs do not start it.
class NotificationSession {
  constructor(devices, options) {
    this.devices = devices;
    this.publisher = new StatePublisher({ clock: options.clock });
    this.flow = new NotificationFlow({
      ...options,
      command: async (method, input) => {
        const entry = input.ownerId === devices.local.id ? null : devices.peers.get(input.ownerId);
        const generation = entry?.peer.generation;
        const result = await devices.command(method, input);
        if (
          entry &&
          (devices.peers.get(input.ownerId) !== entry || entry.peer.generation !== generation)
        )
          throw new Error('The paired connection changed before its reply was confirmed.');
        return result;
      },
      refresh: () => this.observe(),
    });
    this.onChange = () => this.observe();
    this.flow.establish(this.publisher.stamp(devices.snapshot()), { silent: !options.restored });
    devices.on('change', this.onChange);
    // Queue changes also feed this adapter when connected to the desktop's local Queue.
    this.localQueue = options.localQueue;
    this.localQueue?.on('change', this.onChange);
  }
  observe() {
    return this.flow.observe(this.publisher.stamp(this.devices.snapshot()));
  }
  close() {
    this.devices.off('change', this.onChange);
    this.localQueue?.off('change', this.onChange);
  }
}
module.exports = { NotificationSession };
