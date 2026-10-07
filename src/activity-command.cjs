'use strict';
function command(text) {
  if (typeof text !== 'string') return null;
  if (/^\/activity(?: list)?$/i.test(text.trim())) return { kind: 'list', filters: {} };
  const match = text.trim().match(/^\/activity (list|configure|export): ([\s\S]+)$/i);
  if (!match) return null;
  let value;
  try {
    value = JSON.parse(match[2]);
  } catch {
    return { kind: 'invalid' };
  }
  const kind = match[1].toLowerCase();
  if (kind === 'configure') return { kind, config: value };
  if (kind === 'list') {
    if (
      !value ||
      Array.isArray(value) ||
      typeof value !== 'object' ||
      Object.keys(value).some((k) => !['filters', 'limit', 'cursor'].includes(k))
    )
      return { kind: 'invalid' };
    return { ...value, kind };
  }
  if (
    value?.redacted !== true ||
    Object.keys(value).some((k) => !['redacted', 'filters'].includes(k))
  )
    return { kind: 'invalid' };
  return { kind, redacted: true, filters: value.filters === undefined ? {} : value.filters };
}
function manage(store, message, c) {
  if (!store) throw new Error('Activity controls are unavailable');
  const h = {
    role: 'human',
    authority: 'accepted_human',
    actorId: store.options.actorId(),
    messageId: message.id,
    text: message.text,
  };
  let value;
  if (c.kind === 'list') {
    let limit = c.limit ?? 20,
      page;
    do {
      page = store.query({ ...c, limit });
      value = {
        counts: page.counts,
        coverage: page.coverage,
        nextCursor: page.nextCursor,
        events: page.events,
      };
      if (JSON.stringify(value, null, 2).length <= 5300 || limit === 1) break;
      limit--;
    } while (limit >= 1);
    const snapshot = store.options.snapshot?.(),
      seen = new Set();
    message.links = [];
    for (const event of page.events) {
      const card = snapshot?.cards?.find(
        (card) =>
          card.taskKey === event.scope.taskKey &&
          (card.owner?.id || 'local') === event.scope.ownerId &&
          card.sources?.some((s) => s.id === event.scope.sourceId),
      );
      if (card && !seen.has(card.id) && message.links.length < 3) {
        seen.add(card.id);
        message.links.push({
          id: card.id,
          taskKey: card.taskKey,
          sourceId: event.scope.sourceId,
          ownerId: event.scope.ownerId,
          revision: require('./assistant-context.cjs').revision(card),
          chatName: 'Source activity',
          draft: '',
        });
      }
    }
  } else if (c.kind === 'configure') {
    store.configure(h, c.config);
    value = { saved: true, settings: store.state.settings, coverage: store.query().coverage };
  } else if (c.kind === 'export') value = store.export(h, c.filters);
  else throw new Error('Use a literal activity command with valid bounded JSON');
  const answer = JSON.stringify(value, null, 2);
  message.answer =
    answer.slice(0, 5400) +
    (answer.length > 5400
      ? '\nInspection truncated; use fewer events or nextCursor to page retained activity.'
      : '');
  message.status = 'completed';
}
module.exports = { command, manage };
