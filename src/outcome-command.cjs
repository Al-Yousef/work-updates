'use strict';
function command(text) {
  if (typeof text !== 'string' || !/^\/outcome(?:\s|$)/i.test(text)) return null;
  const match = text.match(
    /^\/outcome (require|check|inspect) ([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})(?:: ([\s\S]+))?$/,
  );
  if (!match || (match[1] === 'require' && !match[3]) || (match[1] !== 'require' && match[3]))
    throw new Error('Use /outcome require ID: JSON, /outcome check ID or /outcome inspect ID.');
  return { kind: match[1], id: match[2], spec: match[3] ? JSON.parse(match[3]) : undefined };
}
async function manage(store, message, control) {
  if (!store) throw new Error('Outcome verification is unavailable');
  const human = { role: 'human', messageId: message.id, text: message.text };
  if (control.kind === 'require') store.require(control.id, control.spec, human);
  if (control.kind === 'check') await store.check(control.id, human);
  const result = store.inspect(control.id);
  message.status = 'completed';
  message.responsibilityId = control.id;
  message.answer =
    'Expected ' +
    result.spec.stage +
    ' · ' +
    result.result.status.replaceAll('_', ' ') +
    '\n' +
    result.spec.description +
    '\nProof: ' +
    result.spec.kind +
    '. Target revision: ' +
    result.spec.targetRevision +
    '.\nChecking proof does not finish the responsibility. Use /responsibility verify ' +
    control.id +
    ' after reviewing the result.';
}
module.exports = { command, manage };
