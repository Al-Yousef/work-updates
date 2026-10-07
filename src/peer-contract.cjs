'use strict';
// Peer negotiation is separate from native bridge/snapshot protocol version 3.
const commands = Object.freeze([
  'create',
  'start',
  'action',
  'undo',
  'send',
  'queueMessage',
  'cancelMessage',
  'clearMessages',
  'stop',
  'respond',
  'details',
  'group',
  'refresh',
  'open',
]);
const legacy = Object.freeze([
  'create',
  'start',
  'action',
  'undo',
  'send',
  'stop',
  'respond',
  'details',
  'group',
  'refresh',
  'open',
]);
const mutations = new Set(commands.filter((x) => !['details', 'refresh'].includes(x)));
function capabilities(enabled = commands) {
  if (
    !Array.isArray(enabled) ||
    enabled.some((x) => !commands.includes(x)) ||
    new Set(enabled).size !== enabled.length
  )
    throw new Error('Invalid enabled peer commands');
  return {
    schema: 1,
    version: 2,
    minimumVersion: 1,
    commands: [...enabled],
    receiptVersion: 1,
    attachments: false,
    assistant: false,
    orderedSnapshots: true,
    sourceBoundMessages: true,
  };
}
function negotiate(state) {
  const value = state?.peerContract;
  if (value === undefined)
    return {
      version: 1,
      commands: [...legacy],
      receiptVersion: 0,
      attachments: false,
      assistant: false,
    };
  if (
    !value ||
    value.schema !== 1 ||
    value.version !== 2 ||
    value.minimumVersion !== 1 ||
    value.receiptVersion !== 1 ||
    value.attachments !== false ||
    value.assistant !== false ||
    value.orderedSnapshots !== true ||
    value.sourceBoundMessages !== true ||
    !Array.isArray(value.commands) ||
    value.commands.length > commands.length ||
    value.commands.some((x) => !commands.includes(x)) ||
    new Set(value.commands).size !== value.commands.length
  )
    throw Object.assign(
      new Error('Update the paired client: its capability contract is unsupported.'),
      { code: 'PEER_CAPABILITY', delivery: 'not-sent' },
    );
  return structuredClone(value);
}
function admission(state, method, request) {
  const supported = negotiate(state);
  if (!supported.commands.includes(method))
    throw Object.assign(new Error('This paired computer does not support that action.'), {
      code: 'PEER_CAPABILITY',
      delivery: 'not-sent',
    });
  if (request?.peerProtocolVersion !== undefined) {
    if (request.peerProtocolVersion !== 2 || supported.version !== 2)
      throw Object.assign(new Error('This paired protocol version is unsupported.'), {
        code: 'PEER_CAPABILITY',
        delivery: 'not-sent',
      });
    if (
      mutations.has(method) &&
      (!state.stateVersion?.epoch || request.hostEpoch !== state.stateVersion.epoch)
    )
      throw Object.assign(
        new Error('The paired computer restarted. Reopen its current task before sending.'),
        { code: 'PEER_EPOCH', delivery: 'not-sent' },
      );
    if (['send', 'queueMessage', 'cancelMessage'].includes(method) && request.input) {
      const input = request.input,
        card = [...(state.cards || []), ...(state.done || [])].find(
          (c) => c.id === input.id && c.taskKey === input.taskKey,
        );
      if (
        !card ||
        !card.sources?.some((s) => s.id === input.sourceId) ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(input.messageId || '') ||
        (input.contextRevision !== undefined && input.contextRevision !== card.contextRevision)
      )
        throw Object.assign(
          new Error('The exact paired source, task revision and message identity are required.'),
          { code: 'PEER_SOURCE', delivery: 'not-sent' },
        );
    }
  } else if (!legacy.includes(method)) {
    throw Object.assign(new Error('Update this client to negotiate queued-message actions.'), {
      code: 'PEER_CAPABILITY',
      delivery: 'not-sent',
    });
  }
  return supported;
}
module.exports = { commands, legacy, capabilities, negotiate, admission };
