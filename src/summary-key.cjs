'use strict';
const crypto = require('node:crypto');
const { redact } = require('./diagnostics.cjs');
const VERSION = 1;
function excerpt(value, limit) {
  return redact(String(value || ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}
function summaryInput(source) {
  return {
    chatName: excerpt(source.title, 120),
    request: excerpt(source.taskTitle, 120),
    update: excerpt(source.body || source.summary, 3000),
  };
}
function summaryKey(source) {
  if (
    !source?.id ||
    !source.fingerprint ||
    !source.turnId ||
    !source.contextLoaded ||
    !source.readyForReview ||
    source.lifecycle !== 'completed'
  )
    return null;
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([VERSION, source.id, source.turnId, source.fingerprint, summaryInput(source)]),
    )
    .digest('hex');
}
function validateSummary(value) {
  if (!value || typeof value.title !== 'string' || typeof value.summary !== 'string')
    throw new Error('SUMMARY_INVALID');
  const clean = (text, max) => {
    const result = text.replace(/\s+/g, ' ').trim();
    if (!result || result.length > max || /[<>\x00-\x1f]/.test(result))
      throw new Error('SUMMARY_INVALID');
    return result;
  };
  return { title: clean(value.title, 100), summary: clean(value.summary, 200) };
}
module.exports = { VERSION, summaryInput, summaryKey, validateSummary };
