'use strict';
const { revision } = require('./assistant-context.cjs');
function capture(snapshot, focus) {
  const at = snapshot.collectedAt || snapshot.feedCollectedAt || 0,
    age = Date.now() / 1000 - at;
  if (!snapshot.health?.ok || age < -5 || age > 30 || !at)
    throw new Error('A fresh source snapshot is required; the ledger is unchanged');
  const candidates = [
    ...new Map(
      [...(snapshot.cards || []), ...(snapshot.done || [])].map((c) => [
        (c.owner?.id || 'local') + '\n' + c.id,
        c,
      ]),
    ).values(),
  ].filter(
    (c) =>
      (c.owner?.id || 'local') === focus?.ownerId &&
      c.sources?.some((s) => s.id === focus.sourceId),
  );
  if (candidates.length !== 1 || candidates[0].owner?.online === false)
    throw new Error('Open one available source on its original owner first');
  const card = candidates[0],
    s = card.sources.find((s) => s.id === focus.sourceId);
  if (!s.contextLoaded)
    throw new Error(
      'Original source records are unavailable; generated summaries are not source evidence',
    );
  const all = (s.conversation || []).filter(
      (m) => ['user', 'assistant'].includes(m.role) && typeof m.text === 'string' && m.text,
    ),
    excerpt = String(s.body || '').slice(0, 700),
    records = all.slice(-8).map((m) => ({ role: m.role, text: m.text.slice(0, 300) }));
  let truncated =
    all.length > 8 || all.slice(-8).some((m) => m.text.length > 300) || (s.body || '').length > 700;
  while (JSON.stringify({ excerpt, records }).length > 2000 && records.length) {
    records.shift();
    truncated = true;
  }
  if (!excerpt && !records.length)
    throw new Error('Original source records are unavailable; the ledger is unchanged');
  return {
    kind: 'source_record',
    text: JSON.stringify({ excerpt, records }),
    origin: { role: 'source' },
    source: {
      sourceId: s.id,
      ownerId: card.owner?.id || 'local',
      taskKey: card.taskKey,
      revision: revision(card),
    },
    coverage: {
      state: s.conversationLoaded ? 'bounded_original_records' : 'partial_excerpt',
      collectedAt: at,
      exhaustive: false,
      truncated,
      gaps: s.conversationLoaded
        ? ['Only the selected bounded records were captured']
        : ['Later original replies are unavailable'],
    },
  };
}
module.exports = { capture };
