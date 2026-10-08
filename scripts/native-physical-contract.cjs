'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const sourceId = '10000000-0000-4000-8000-000000000001';
const draft = 'Synthetic QA draft Ω';
function configuration(env = process.env) {
  if (env.HYPHEN_PHYSICAL_INPUT !== 'separate-cursor' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(env.CODEX_THREAD_ID || '') ||
      !path.isAbsolute(env.HYPHEN_CURSOR_CLI || '') ||
      path.basename(env.HYPHEN_CURSOR_CLI).toLowerCase() !== 'agent_cli.py' ||
      !fs.statSync(env.HYPHEN_CURSOR_CLI, {throwIfNoEntry:false})?.isFile())
    throw new Error('Explicit chat-owned separate-cursor configuration required');
  return {chatId:env.CODEX_THREAD_ID, cursor:env.HYPHEN_CURSOR_CLI,
    python:env.WORK_UPDATES_PYTHON || 'python'};
}
function verify(report, revision, chatId, nativePid) {
  assert.ok(Number.isSafeInteger(nativePid) && nativePid > 0);
  assert.equal(report.schema, 1);
  assert.equal(report.sourceRevision, revision);
  assert.equal(report.chatId, chatId);
  assert.equal(report.nativePid, nativePid);
  assert.equal(report.accountsUsed, 0);
  assert.equal(report.modelCalls, 0);
  assert.equal(report.installedAppChanged, false);
  assert.equal(report.evidence, 'separate_cursor_owned_synthetic_native_controls');
  assert.equal(report.inputBackend, 'private_input_v2');
  assert.equal(report.processIdentityPreserved, true);
  assert.equal(report.passed, true);
  assert.deepEqual(report.checks, ['source_selection','unicode_draft_readback',
    'draft_preserved_after_navigation','exactly_once_synthetic_delivery','panel_hidden','owned_input_released']);
  assert.equal(report.sent.length, 1);
  assert.deepEqual(report.sent[0], {threadId:sourceId,text:draft,images:[]});
  const desktop = report.desktop;
  assert.equal(desktop.independentOfTargetAndCursorProcesses, true);
  assert.equal(desktop.unchanged, true);
  assert.ok(Number.isSafeInteger(desktop.samples) && desktop.samples >= 20 &&
    Number.isFinite(desktop.durationMs) && desktop.durationMs >= 100 && desktop.durationMs <= 180000 &&
    Number.isFinite(desktop.maximumGapMs) && desktop.maximumGapMs >= 0 && desktop.maximumGapMs <= 50);
  assert.equal(desktop.betweenSamplesUnverified, true);
  return report;
}
module.exports = {configuration, verify, sourceId, draft};
