'use strict';
// Opt-in private inference over synthetic retained history/source data only.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { Assistant } = require('../src/assistant.cjs');
if (!process.argv.includes('--allow-private-model')) throw new Error('Requires explicit human authorization and --allow-private-model; consumes signed-in Codex model quota.');
const directory = path.resolve(process.argv.find(arg => arg.startsWith('--output='))?.slice(9) || 'artifacts/assistant-memory-model-' + Date.now());
fs.mkdirSync(directory, { recursive: true });
const card = { id: 'release', taskKey: 'release-v1', kind: 'local', chatName: 'Release review', title: 'Review release', summary: 'A generated summary suggested it was complete', summaryOrigin: 'ai', status: 'ready', at: 1,
  owner: { id: 'test-pc', online: false }, primarySourceId: 'test-source', sources: [{ id: 'test-source', contextLoaded: true, conversationLoaded: true, lifecycle: 'completed', body: 'Cached checklist awaits approval.',
    conversation: [{ role: 'user', text: 'Keep the release private until I approve it.' }, { role: 'assistant', text: 'A draft checklist is prepared; nothing was published.' }] }] };
const snapshot = () => ({ cards: [card], done: [], health: { ok: true }, collectedAt: Math.floor(Date.now() / 1000) });
let dispatches = 0;
const options = { directory, snapshot, dispatch: async () => { dispatches++; throw new Error('Synthetic audit must not dispatch'); } };
let app = new Assistant(options);
const exchange = (text, answer = 'Understood.') => ({ id: crypto.randomUUID(), text, answer, status: 'completed', at: Date.now(), links: [] });
const steps = [];
async function ask(text, validate) {
  const id = crypto.randomUUID(), started = Date.now();
  app.ask({ messageId: id, text }); await app.work;
  const message = app.state.messages.find(m => m.id === id);
  assert.equal(message.status, 'completed', message.error);
  validate(message);
  steps.push({ passed: true, model: message.model, elapsedMs: Date.now() - started, answer: message.answer });
}
(async () => {
  try {
    app.state.messages = [exchange('My release codename is Indigo.'), exchange('Correction: my release codename is Maple now.', 'The codename is probably still Indigo.'),
      ...Array.from({ length: 20 }, (_, i) => exchange('A separate synthetic gardening discussion ' + i))];
    app.save(); app.close(); app = new Assistant(options);
    await ask('What is my current release codename? Answer with only the current codename.', m => { assert.match(m.answer, /Maple/i); assert.doesNotMatch(m.answer, /Indigo/i); });
    await ask('Is Release review verified as published? Explain which original evidence is available and whether it is current.', m => {
      assert.match(m.answer, /offline|cached|not current/i); assert.match(m.answer, /not published|nothing was published|not verified|unconfirmed|cannot verify|can.t verify|not.*confirmed/i);
    });
    app.state.messages.push({ ...exchange('Which chat was that?', 'Probably Release review.'), links: [{ id: 'release', taskKey: 'release-v1', sourceId: 'test-source', ownerId: 'test-pc', chatName: 'Release review', draft: '' }] });
    app.save();
    await ask('Tell that chat to review the checklist.', m => { assert.equal(m.action, undefined); assert.doesNotMatch(m.answer, /^(?:Sent|Queued) to/); });
    assert.equal(dispatches, 0);
    const report = { passed: true, cases: steps.length, model: steps.at(-1).model, elapsedMs: steps.reduce((n, s) => n + s.elapsedMs, 0), actualUsageAvailable: false,
      usageNote: 'The current assistant provider does not expose billed token/cost usage; elapsed time and model are metadata, not cost.', coverage: 'Synthetic corrected history after restart, offline source evidence and an unconfirmed suggested destination', realChatsTouched: 0, connectorCalls: 0, dispatches: 0, steps };
    fs.writeFileSync(path.join(directory, 'verification.json'), JSON.stringify(report, null, 2));
    const { steps: answers, ...summary } = report; console.log(JSON.stringify(summary));
  } finally { app.close(); }
})().catch(error => { fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({ passed: false, error: error.message, steps }, null, 2)); console.error(error.message); process.exitCode = 1; });
