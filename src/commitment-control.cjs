'use strict';
function inspect(e) {
  return {
    id: e.id,
    title: e.title,
    owner: e.owner,
    status: e.status,
    deadline: e.deadline,
    blockers: e.blockers.slice(0, 4).map((b) => b.slice(0, 200)),
    confidence: e.confidence,
    responsibilityId: e.responsibilityId,
    revision: e.revision,
    supersededBy: e.supersededBy,
    provenance: Object.fromEntries(
      Object.entries(e.provenance).map(([k, v]) => [
        k,
        { kind: v.kind, messageId: v.origin.messageId },
      ]),
    ),
    evidence: e.evidence.slice(-4).map((x) => ({
      kind: x.kind,
      text: x.text.slice(0, 250),
      source: x.source,
      coverage: x.coverage,
      verification: x.verification,
    })),
    history: e.history.slice(-4).map((h) => ({
      action: h.action,
      revision: h.revision,
      fields: h.fields,
      messageId: h.origin.messageId,
    })),
    coverage: {
      evidenceIncluded: Math.min(e.evidence.length, 4),
      evidenceTotal: e.evidence.length,
      historyIncluded: Math.min(e.history.length, 4),
      historyTotal: e.history.length,
      blockersIncluded: Math.min(e.blockers.length, 4),
      blockersTotal: e.blockers.length,
    },
  };
}
function manage(store, message, command, snapshot) {
  if (!store) throw new Error('The commitment ledger is unavailable in this session');
  const human = {
    role: 'human',
    authority: 'accepted_human',
    actorId: store.options.humanActorId,
    messageId: message.id,
    text: message.text,
  };
  let id = command.id;
  if (command.kind === 'list')
    message.answer =
      store
        .snapshot()
        .slice(-12)
        .map((e) => e.title.slice(0, 180) + ' · ' + e.status + ' · ' + e.confidence + '\n' + e.id)
        .join('\n\n') || 'No commitments yet. Use /commitment add: TITLE to save one.';
  else if (
    command.kind === 'preferences' ||
    command.kind === 'preference' ||
    command.kind === 'delete_preference'
  ) {
    if (command.kind === 'preference') store.preference(human, command.key, command.value);
    if (command.kind === 'delete_preference') store.deletePreference(human, command.key);
    const saved = store.preferenceSnapshot();
    message.answer =
      'Explicit preferences:\n' +
      (Object.entries(saved)
        .map(([key, p]) => key + ': ' + p.value)
        .join('\n') || 'None saved.') +
      '\nUnset preferences inherit existing settings. Notifications control local desktop attention; research off prevents new source-detail reads for questions. Authorization uses separate scoped grants.';
  } else if (command.kind === 'history' || command.kind === 'evidence') {
    const e = store.entry(id),
      items = e[command.kind],
      size = command.kind === 'history' ? 4 : 1,
      pages = Math.max(1, Math.ceil(items.length / size)),
      selected = items.slice((command.page - 1) * size, command.page * size);
    if (command.page > pages)
      throw new Error('That page is unavailable; there are ' + pages + ' pages');
    message.commitmentId = id;
    message.answer =
      command.kind +
      ' page ' +
      command.page +
      ' of ' +
      pages +
      ' for ' +
      id +
      '\n' +
      selected
        .map((x) => {
          if (command.kind === 'history')
            return JSON.stringify({
              action: x.action,
              revision: x.revision,
              fields: x.fields,
              at: x.at,
              origin: {
                messageId: x.origin.messageId,
                actorId: x.origin.actorId,
                text: x.origin.text.slice(0, 400),
                truncated: x.origin.text.length > 400,
              },
            });
          const metadata = JSON.stringify({
            kind: x.kind,
            originRole: x.origin.role,
            source: x.source,
            coverage: x.coverage,
            verification: x.verification,
            at: x.at,
          });
          return (
            metadata.slice(0, 1200) +
            (metadata.length > 1200 ? ' [metadata truncated]' : '') +
            '\n' +
            x.text
          );
        })
        .join('\n\n');
  } else {
    if (command.kind === 'add') id = store.add(human, command.title);
    else if (command.kind === 'correct') store.correct(human, id, command.patch, command.literal);
    else if (command.kind === 'verify') store.verify(human, id, command.description);
    else if (command.kind === 'supersede') id = store.supersede(human, id, command.title);
    else if (command.kind === 'source')
      store.attach(human, id, require('./commitment-source.cjs').capture(snapshot, message.focus));
    else if (command.kind === 'delete') {
      store.delete(human, id);
      message.answer =
        'Deleted commitment ' +
        id +
        ' and its ledger evidence and update history. A text-free deletion marker and replay hashes remain. Hyphen conversation, images, pinned notes and the original source chat have separate deletion controls.';
      message.status = 'completed';
      message.commitmentId = id;
      return;
    }
    const e = store.entry(id);
    message.commitmentId = id;
    const rendered = JSON.stringify(inspect(e), null, 2);
    message.answer =
      rendered.slice(0, 5200) +
      (rendered.length > 5200 ? '\nInspection is truncated.' : '') +
      '\nSaved state was read back from the ledger. Use history ID PAGE or evidence ID PAGE for older records. Human review and independent outcome proof are distinct.';
  }
  message.status = 'completed';
}
module.exports = { manage, inspect };
