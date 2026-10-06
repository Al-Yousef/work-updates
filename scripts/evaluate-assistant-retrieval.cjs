'use strict';
// Synthetic retrieval conformance. This scores context selection, not model quality.
const { history, context, messageTarget } = require('../src/assistant-context.cjs');
const exchange = (user, assistant = 'Understood.', id = 'exchange') => ({ id, text: user, answer: assistant, at: 1, status: 'completed', links: [] });
const unrelated = n => Array.from({ length: n }, (_, i) => exchange('A separate gardening conversation ' + i, 'Understood.', 'other-' + i));
const card = (name, id = 'one', extra = {}) => ({ id, taskKey: id + '-v1', chatName: name, title: name, summary: 'Recorded queue update', status: 'ready', kind: 'local', at: 1,
  primarySourceId: 'source-' + id, owner: { id: 'pc', online: true }, sources: [{ id: 'source-' + id, contextLoaded: true, conversationLoaded: true, body: 'Recorded source evidence', conversation: [{ role: 'user', text: 'The checklist needs review.' }] }], ...extra });
const snapshot = cards => ({ cards, done: [], health: { ok: true }, collectedAt: Math.floor(Date.now() / 1000) });
function evaluate() {
  const results = [];
  const check = (name, run) => { try { results.push({ name, passed: !!run() }); } catch { results.push({ name, passed: false }); } };
  check('older human decision survives topic changes', () => {
    const h = history([exchange('For Neptune use amber.', 'Understood.', 'decision'), ...unrelated(20)], { id: 'current', text: 'What did we choose for Neptune?' });
    return h.recalled.some(m => m.user.includes('amber')) && h.userEvidence.some(m => m.text.includes('amber'));
  });
  check('older correction remains beside its original evidence', () => {
    const h = history([exchange('My release codename is Indigo.', '', 'old'), exchange('Correction: my release codename is Maple now.', '', 'new'), ...unrelated(20)], { id: 'current', text: 'What is my release codename?' });
    const correction = h.userEvidence.findIndex(m => m.text.includes('Maple'));
    return correction >= 0 && correction > h.userEvidence.findIndex(m => m.text.includes('Indigo'));
  });
  check('generated guesses have no human-evidence provenance', () => {
    const h = history([exchange('Which layout?', 'Probably Neptune uses violet.', 'guess'), ...unrelated(20)], { id: 'current', text: 'What layout does Neptune use?' });
    return h.recalled.some(m => m.assistant.includes('violet') && m.provenance.assistant === 'generated_answer') && !h.userEvidence.some(m => m.text.includes('violet'));
  });
  check('alert flooding cannot enter conversation recall', () => {
    const h = history([exchange('Use amber for Neptune.'), ...unrelated(20), ...Array.from({ length: 80 }, (_, i) => ({ ...exchange('', 'Neptune violet alert', 'alert-' + i), kind: 'update' }))], { id: 'current', text: 'Neptune layout?' });
    return h.coverage.retainedExchanges === 21 && h.recalled.some(m => m.user.includes('amber')) && !JSON.stringify(h.recalled).includes('violet alert');
  });
  check('generated related link cannot resolve a pronoun', () => {
    const c = card('Launch planning');
    const prior = { ...exchange('Which chat was that?', 'Probably Launch planning.'), links: [{ id: c.id, sourceId: c.primarySourceId, ownerId: 'pc', chatName: c.chatName }] };
    const selection = { history: [prior] };
    return messageTarget(context(snapshot([c]), 'Tell that chat to review it', selection), 'Tell that chat to review it', selection) === null;
  });
  check('two human-named destinations remain ambiguous', () => {
    const cards = [card('Launch planning', 'launch'), card('Release review', 'release')];
    const prior = { ...exchange('Compare Launch planning and Release review.'), links: cards.map(c => ({ id: c.id, sourceId: c.primarySourceId, ownerId: 'pc', chatName: c.chatName })) };
    const selection = { history: [prior] };
    return messageTarget(context(snapshot(cards), 'Tell that chat to continue', selection), 'Tell that chat to continue', selection) === null;
  });
  check('rejecting a guessed name cannot confirm its suggested link', () => {
    const c = card('Release review');
    const prior = { ...exchange('No, that was not Release review.', 'Understood.'), links: [{ id: c.id, sourceId: c.primarySourceId, ownerId: 'pc', chatName: c.chatName }] };
    const selection = { history: [prior] };
    return messageTarget(context(snapshot([c]), 'Tell that chat to continue', selection), 'Tell that chat to continue', selection) === null;
  });
  check('duplicate chat names do not confirm a source', () => {
    const cards = [card('Release review', 'one'), card('Release review', 'two')];
    const selection = { history: [{ ...exchange('Ask Release review.'), links: [{ id: 'one', sourceId: 'source-one', ownerId: 'pc', chatName: 'Release review' }] }] };
    return messageTarget(context(snapshot(cards), 'Tell that chat to continue', selection), 'Tell that chat to continue', selection) === null;
  });
  check('an explicit topic beats an unrelated focused source', () => {
    const cards = [card('Launch planning', 'launch'), card('Neptune layout', 'neptune')];
    const c = context(snapshot(cards), 'What did Neptune layout decide?', { focus: { id: 'launch', sourceId: 'source-launch', ownerId: 'pc' } });
    return c.data.cards[0].chatName === 'Neptune layout' && c.data.cards[0].conversation[0].provenance === 'source_chat_evidence';
  });
  check('offline source evidence is labelled offline', () => context(snapshot([card('Release', 'one', { owner: { id: 'remote', online: false } })]), 'Release').data.cards[0].sourceCoverage.state === 'offline');
  check('future collection timestamps cannot claim fresh evidence', () => !context({ ...snapshot([card('Release')]), collectedAt: Math.floor(Date.now() / 1000) + 500 }, 'Release').data.fresh);
  check('source truncation and generated summaries are explicit', () => {
    const c = card('Release', 'one', { summaryOrigin: 'ai' }); c.sources[0].body = 'x'.repeat(4000);
    const selected = context(snapshot([c]), 'Release').data.cards[0];
    return selected.sourceCoverage.truncated && selected.summaryProvenance === 'generated_summary' && selected.excerpt.length === 1600;
  });
  check('context budgets bound long retained history and source cards', () => {
    const h = history(Array.from({ length: 30 }, (_, i) => exchange('Neptune '.repeat(500), 'Answer '.repeat(800), 'large-' + i)), { id: 'current', text: 'Neptune?' });
    const c = context(snapshot(Array.from({ length: 200 }, (_, i) => card('Release ' + i, String(i)))), 'Release');
    return h.coverage.selectedCharacters <= 20000 && h.coverage.userEvidenceCharacters <= 4000 && JSON.stringify(c.data.cards).length <= 18000 + 40;
  });
  const passed = results.filter(r => r.passed).length;
  return { scope: 'Synthetic context-selection and provenance checks; no model, signed-in chat or connector calls', cases: results.length, passed, score: passed / results.length, results };
}
module.exports = { evaluate };
if (require.main === module) { const report = evaluate(); console.log(JSON.stringify(report, null, 2)); if (report.score !== 1) process.exitCode = 1; }
