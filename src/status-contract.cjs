'use strict';
const { priorityRank } = require('./attention.cjs');
const SUMMARY_NOTICES = {
  cached: 'Saved summary', pending: 'Summary pending · recorded update shown',
  failed: 'Summary unavailable · recorded update shown', disabled: 'Recorded update · summaries off',
  rate_limited: 'Summary paused · recorded update shown', recorded: 'Recorded update',
};
function compareCards(a, b) {
  const time = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const identity = card => String(card.owner?.id || '') + '\0' + card.id + '\0' + (card.taskKey || '');
  const left = identity(a), right = identity(b);
  return priorityRank(a) - priorityRank(b) || time(b.at ?? b.updatedAt) - time(a.at ?? a.updatedAt) ||
    (left < right ? -1 : left > right ? 1 : 0);
}
function availability({ owner, health, collectedAt, live = false, now = Date.now() / 1000 } = {}) {
  if (owner?.online === false) return { state: 'offline', provenance: 'execution-owner', cached: true };
  if (live) return { state: 'fresh', provenance: 'local-writer', cached: false };
  const age = now - Number(collectedAt);
  if (health?.ok === false || (collectedAt !== undefined && (!Number.isFinite(age) || Number(collectedAt) <= 0 || age < -5 || age > 30)))
    return { state: 'stale', provenance: 'collector', cached: true };
  if (collectedAt === undefined) return { state: 'unknown', provenance: 'not-recorded', cached: false };
  return { state: 'fresh', provenance: 'collector', cached: false };
}
function projectStatus(card, options = {}) {
  const evidence = availability({ ...options, owner: card.owner || options.owner });
  const sourceStatus = card.sourceStatus || card.status;
  const outdated = ['offline', 'stale'].includes(evidence.state);
  const status = outdated && ['working', 'starting'].includes(card.status) ? 'unknown' : card.status;
  const sourceLabel = card.sourceLabel || card.label;
  const label = outdated ? (evidence.state === 'offline' ? 'Offline · last known: ' : 'Stale · last known: ') +
    (sourceLabel || sourceStatus || 'status unclear') : sourceLabel;
  const summaryState = Object.hasOwn(SUMMARY_NOTICES, card.summaryState) ? card.summaryState : 'recorded';
  return { ...card, status, sourceStatus, sourceLabel, label, availability: evidence,
    activity: !outdated && ['working', 'starting'].includes(status), summaryState,
    summaryNotice: SUMMARY_NOTICES[summaryState],
    device: { ...card.device, ...(evidence.state === 'offline' ? { online: false } : {}) } };
}
module.exports = { SUMMARY_NOTICES, compareCards, availability, projectStatus };
