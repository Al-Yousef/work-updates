'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { Assistant } = require('../src/assistant.cjs');
const { evaluate } = require('../scripts/evaluate-assistant-retrieval.cjs');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-memory-quality-'));
  const provider = { async answer() { return { answer: 'Understood.', links: [], action: null }; }, close() {} };
  const options = { directory, provider, snapshot: () => ({ cards: [], health: { ok: true }, collectedAt: Math.floor(Date.now() / 1000) }) };
  const app = new Assistant(options);
  t.after(() => { app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const ask = async text => { const id = crypto.randomUUID(); app.ask({ messageId: id, text }); await app.work; return id; };
  return { app, options, ask };
}
test('scored adversarial retrieval fixtures pass without model inference', () => { const report = evaluate(); assert.equal(report.cases, 13); assert.equal(report.score, 1, JSON.stringify(report.results.filter(r => !r.passed))); });
test('pinned correction survives restart and does not rewrite retained conversation', async t => {
  const f = fixture(t); await f.ask('Remember that release codename is Indigo.'); await f.ask('/correct 1 release codename is Maple.');
  const restored = new Assistant(f.options); t.after(() => restored.close());
  assert.deepEqual(restored.state.notes, ['release codename is Maple.']);
  assert.ok(restored.state.messages.some(m => m.text.includes('Indigo')));
});
test('precise history deletion removes inspection copies but retains notes and replay protection', async t => {
  const f = fixture(t); const id = await f.ask('An ordinary private detail.'); await f.ask('Remember that keep this note.'); await f.ask('/memory history');
  assert.ok(f.app.state.messages.some(m => m.answer?.includes('ordinary private detail')));
  const receipt = f.app.state.receipts[id]; await f.ask('/forget history 1');
  assert.ok(!JSON.stringify(f.app.state.messages).includes('ordinary private detail'));
  assert.deepEqual(f.app.state.notes, ['keep this note.']); assert.equal(f.app.state.receipts[id], receipt);
  const restored = new Assistant(f.options); t.after(() => restored.close());
  assert.ok(!JSON.stringify(restored.state.messages).includes('ordinary private detail'));
  assert.equal(restored.state.receipts[id], receipt);
});
test('clearing conversation states what remains and leaves independent note storage intact', async t => {
  const f = fixture(t); await f.ask('Remember that keep this note.'); await f.ask('An ordinary private detail.'); await f.ask('/forget history all');
  assert.deepEqual(f.app.state.notes, ['keep this note.']); assert.equal(f.app.state.messages.length, 1);
  assert.match(f.app.state.messages[0].answer, /source chats.*replay protection remain/);
});
test('invalid inspection metadata is preserved rather than repaired into new writable history', t => {
  const f = fixture(t); f.app.state.historySelection = ['x'.repeat(101)]; fs.writeFileSync(f.app.file, JSON.stringify(f.app.state));
  const bytes = fs.readFileSync(f.app.file); const restored = new Assistant(f.options); t.after(() => restored.close());
  assert.match(restored.error, /preserved/); assert.ok(fs.readFileSync(f.app.file).equals(bytes));
});
