'use strict';
const { revision } = require('./assistant-context.cjs');
const { fresh, sourceFor } = require('./assistant-coordination.cjs');
function currentScope(identity, snapshot) {
  const match = sourceFor(snapshot, identity);
  if (
    !fresh(snapshot) ||
    !match ||
    match.card.done ||
    match.card.owner?.online === false ||
    match.source.deliveryIssue
  )
    throw new Error(
      'The original source is unavailable or its state is stale. The responsibility is kept.',
    );
  const { card, source } = match,
    device = source.device || card.device || {};
  return {
    id: card.id,
    taskKey: card.taskKey,
    sourceId: source.id,
    ownerId: card.owner?.id || 'local',
    deviceId: card.owner?.id || 'local',
    executionDevice: {
      kind: device.kind || card.owner?.kind || 'unknown',
      name: device.label || card.owner?.name || 'Unknown device',
    },
    taskRevision: revision(card),
    chatName: String(card.chatName || card.title || 'Source chat').slice(0, 180),
  };
}
function validateTarget(scope, snapshot) {
  const current = currentScope(scope, snapshot);
  if (
    current.id !== scope.id ||
    current.taskKey !== scope.taskKey ||
    current.taskRevision !== scope.taskRevision ||
    current.deviceId !== scope.deviceId ||
    JSON.stringify(current.executionDevice) !== JSON.stringify(scope.executionDevice)
  )
    throw new Error('The source revision or execution device changed. Nothing was dispatched.');
  return current;
}
module.exports = { currentScope, validateTarget };
