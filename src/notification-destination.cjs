'use strict';
const { readStore } = require('./private-store.cjs'),
  { hash } = require('./triage.cjs');
function receipt(delivery, kind, at, synthetic = false) {
  return {
    deliveryId: delivery.id,
    payloadHash: delivery.payloadHash,
    destinationKey: hash(delivery.destination),
    kind,
    at,
    synthetic,
  };
}
function destination({
  assistant,
  deviceId,
  Notification,
  show,
  systemEnabled = () => true,
  now = Date.now,
  timeoutMs = 5000,
  syntheticSystem = false,
}) {
  function supports(dest) {
    return (
      dest?.deviceId === deviceId &&
      dest.audience === 'self' &&
      (dest.kind === 'inbox' || (dest.kind === 'system' && !!Notification?.isSupported()))
    );
  }
  function available(dest) {
    return supports(dest) && (dest.kind !== 'system' || systemEnabled());
  }
  function probe(delivery) {
    if (
      delivery.destination.kind !== 'inbox' ||
      delivery.destination.deviceId !== deviceId ||
      delivery.destination.audience !== 'self'
    )
      return null;
    const state = readStore(assistant.file).value,
      message = state?.messages.find((m) => m.id === delivery.id);
    if (!message) return null;
    if (
      message.kind !== 'update' ||
      message.answer !== delivery.payload.text ||
      message.notification?.payloadHash !== delivery.payloadHash ||
      message.notification.destinationKey !== hash(delivery.destination)
    )
      throw new Error('Inbox identity or content differs');
    return receipt(delivery, 'inbox_stored', message.at);
  }
  async function deliver(delivery) {
    if (!available(delivery.destination)) throw new Error('Destination temporarily unavailable');
    if (delivery.destination.kind === 'inbox') {
      const existing = probe(delivery);
      if (existing) return existing;
      if (assistant.closed || assistant.error) throw new Error('Inbox requires recovery');
      const prior = structuredClone(assistant.state),
        at = now();
      assistant.state.messages.push({
        id: delivery.id,
        text: '',
        answer: delivery.payload.text,
        kind: 'update',
        status: 'completed',
        at,
        links: [],
        notification: {
          payloadHash: delivery.payloadHash,
          destinationKey: hash(delivery.destination),
          findingHash: delivery.findingHash,
        },
      });
      let confirmed;
      try {
        assistant.save();
        confirmed = probe(delivery);
        if (!confirmed) throw new Error('Inbox write was not verified');
      } catch (error) {
        assistant.state = prior;
        assistant.error =
          'Notification inbox storage could not be verified. The original file is preserved.';
        throw error;
      }
      // Storage acceptance survives a failed UI subscriber. Rolling back the
      // in-memory inbox here could erase the verified message on its next save.
      try {
        assistant.emit('change');
      } catch {}
      return confirmed;
    }
    return new Promise((resolve) => {
      let finished = false,
        notification;
      const settle = (result) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          resolve(result);
        },
        timer = setTimeout(() => settle(null), timeoutMs);
      try {
        notification = new Notification({
          title: 'Hyphen work update',
          body: delivery.payload.text.slice(0, 350),
        });
        notification.once('show', () =>
          settle(receipt(delivery, 'os_shown', now(), syntheticSystem)),
        );
        notification.once('failed', () => settle(null));
        notification.on('click', () => show?.());
        notification.show();
      } catch {
        settle(null);
      }
    });
  }
  return { supports, available, deliver, probe };
}
module.exports = { destination, receipt };
