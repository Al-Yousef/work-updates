'use strict';
const { currentScope } = require('./responsibility-target.cjs');
function inspect(e) {
  return {
    id: e.id,
    sourceId: e.scope.sourceId,
    ownerId: e.scope.ownerId,
    accountKind: 'source_owner',
    accountId: e.scope.ownerId,
    sourceRevision: e.scope.taskRevision,
    grantId: e.grantId,
    topic: e.config.topic,
    configuration: e.config,
    phase: e.phase,
    pendingOperationId: e.pending?.id || null,
    actualReadAttempts: e.attempts.length,
    cursor: e.cursor,
    lastScan: e.scans.at(-1) || null,
    nextReadAt: e.nextReadAt,
    retainedRecords: e.records.length,
    records: e.records.slice(-8).map((r) => ({
      ...r,
      text: r.text.slice(0, 500),
      truncated: r.truncated || r.text.length > 500,
    })),
    capabilities: {
      originalSourceRead: true,
      write: false,
      send: false,
      browserControl: false,
      backgroundInference: false,
    },
    interpretation:
      'A bounded original-record read is not exhaustive coverage or independent completion verification.',
  };
}
async function manage(store, message, command, snapshot) {
  if (!store) throw new Error('Scoped research is unavailable');
  const human = {
    role: 'human',
    authority: 'accepted_human',
    actorId: store.options.policy.actorId,
    messageId: message.id,
    text: message.text,
  };
  let id = command.id;
  if (command.kind === 'list')
    message.answer =
      store
        .snapshot()
        .slice(-12)
        .map((e) => e.scope.chatName + ' · ' + e.config.topic + ' · ' + e.phase + '\n' + e.id)
        .join('\n\n') ||
      'No research sources enabled. New background reads and inference are off by default.';
  else {
    if (command.kind === 'enable') {
      const candidates = [...(snapshot.cards || []), ...(snapshot.done || [])].filter(
        (c) => c.owner?.local && c.sources?.some((s) => s.id === command.sourceId),
      );
      const owners = [...new Set(candidates.map((c) => c.owner.id))];
      if (owners.length !== 1) throw new Error('Choose one exact available local source owner');
      id = store.enable(
        human,
        currentScope({ sourceId: command.sourceId, ownerId: owners[0] }, snapshot),
        command.config,
      );
    } else if (command.kind === 'read') await store.read(id, { manual: true });
    else if (command.kind !== 'inspect') store.control(id, command.kind, human);
    message.researchId = id;
    const rendered = JSON.stringify(inspect(store.entry(id)), null, 2);
    message.answer =
      rendered.slice(0, 5200) +
      (rendered.length > 5200 ? '\nInspection truncated.' : '') +
      '\nOnly literal original records are retained. Later replies and coverage gaps must be considered before interpreting assignments or completion. No write/send/browser authority is granted.';
  }
  message.status = 'completed';
}
module.exports = { manage, inspect };
