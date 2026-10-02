'use strict';
function taskSource(card, sourceId) {
  if (!card) throw new Error('This task is no longer available.');
  const id = sourceId || card.primarySourceId || card.sources[0]?.id;
  const source = card.sources.find((s) => s.id === id);
  if (!source) throw new Error('This chat is no longer attached to the task. Reopen its update.');
  return source;
}
module.exports = { taskSource };
