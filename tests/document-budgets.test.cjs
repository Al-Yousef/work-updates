'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { Documents } = require('../src/documents.cjs'),
  { ResourceBudgets, defaults } = require('../src/resource-budgets.cjs');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-document-budgets-')),
    actorId = 'human:local',
    source = path.join(directory, 'original.md');
  let now = 100000;
  fs.writeFileSync(source, 'Original text');
  const budgetOptions = { directory, actorId, now: () => now },
    budgets = new ResourceBudgets(budgetOptions),
    documentOptions = { directory, actorId, budgets, now: () => now },
    documents = new Documents(documentOptions),
    human = (text) => ({
      role: 'human',
      authority: 'accepted_human',
      actorId,
      messageId: crypto.randomUUID(),
      text,
    }),
    spec = { file: source, title: 'Synthetic owned copy' },
    importInput = human('/document import ' + JSON.stringify(spec));
  t.after(() => {
    budgets.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    source,
    budgets,
    documents,
    budgetOptions,
    documentOptions,
    human,
    importInput,
    import: () => documents.import(importInput, spec),
    configure: (patch) => {
      const config = {
        until: new Date(now + 3600000).toISOString(),
        limits: { ...defaults, ...patch },
      };
      budgets.configure(human('/budget global: ' + JSON.stringify(config)), 'global', config);
    },
    draft: (d, replacement) => {
      const spec = { mode: 'draft', revision: d.revision, start: 1, end: 1, replacement };
      return documents.request(
        human('/document request ' + d.id + ': ' + JSON.stringify(spec)),
        d.id,
        spec,
      );
    },
    schedule: (d, append) => {
      const spec = {
        revision: d.revision,
        everySeconds: 60,
        until: now + 3600000,
        maxRuns: 2,
        append,
      };
      return documents.schedule(
        human('/document schedule ' + d.id + ': ' + JSON.stringify(spec)),
        d.id,
        spec,
      );
    },
    advance: () => {
      now += 60000;
    },
  };
}
test('exhausted shared budgets prevent import, confirmed edits and due scheduled output while inspection and cancellation remain available', (t) => {
  const f = fixture(t);
  f.configure({ runs: 0 });
  assert.throws(f.import, { code: 'RESOURCE_BUDGET' });
  assert.equal(fs.existsSync(f.documents.library), false);
  assert.equal(fs.existsSync(f.documents.file), false);
  assert.deepEqual(f.budgets.state.entries, []);
  f.configure({ runs: 1 });
  const d = f.import(),
    draft = f.draft(d, 'Reviewed edit');
  assert.throws(
    () => f.documents.apply(f.human('/document apply ' + draft.draftId), draft.draftId),
    { code: 'RESOURCE_BUDGET' },
  );
  assert.equal(f.documents.state.drafts[0].status, 'draft');
  assert.deepEqual(f.documents.state.receipts, []);
  const schedule = f.schedule(d, '\nScheduled output');
  f.advance();
  f.documents.tick();
  assert.equal(f.documents.state.schedules[0].status, 'held');
  assert.deepEqual(f.documents.state.schedules[0].runs, []);
  assert.equal(f.documents.read(d.id).text, 'Original text');
  assert.equal(fs.readFileSync(f.source, 'utf8'), 'Original text');
  assert.equal(f.documents.inspect().documents[0].available, true);
  f.documents.cancel(f.human('/document cancel ' + schedule.scheduleId), schedule.scheduleId);
  assert.equal(f.documents.state.schedules[0].status, 'cancelled');
  assert.equal(f.budgets.state.entries.length, 1);
});
test('actual imported, edited and scheduled local files settle as model-free operations and no exhausted schedule catches up or replays', (t) => {
  const f = fixture(t);
  f.configure({ runs: 3, costMicros: 0 });
  const d = f.import(),
    draft = f.draft(d, 'Reviewed edit'),
    input = f.human('/document apply ' + draft.draftId);
  assert.equal(f.documents.apply(input, draft.draftId).status, 'applied');
  f.schedule(f.documents.read(d.id), '\nOne verified output');
  f.advance();
  f.documents.tick();
  f.advance();
  f.documents.tick();
  f.documents.tick();
  assert.equal(f.documents.read(d.id).text, 'Reviewed edit\nOne verified output');
  assert.equal(fs.readFileSync(f.source, 'utf8'), 'Original text');
  assert.equal(f.documents.state.receipts.length, 2);
  assert.equal(f.documents.state.schedules[0].runs.length, 1);
  assert.equal(f.documents.state.schedules[0].status, 'held');
  assert.equal(f.budgets.accounting('global').runs, 3);
  assert.equal(f.budgets.accounting('global').unknownUsage, 0);
  assert.equal(f.budgets.accounting('global').concurrency, 0);
  for (const e of f.budgets.state.entries) {
    assert.equal(e.provider, 'local-private-text');
    assert.equal(e.model, 'none');
    assert.equal(e.status, 'settled');
    assert.equal(e.usage, null);
    assert.deepEqual(e.actual, { tokens: 0, costMicros: 0 });
  }
  assert.throws(f.import, { code: 'RESOURCE_PENDING' });
  assert.throws(() => f.documents.apply(input, draft.draftId), { code: 'DOCUMENT_REQUEST_HELD' });
  assert.equal(f.budgets.state.entries.length, 3);
});
test('lost document write acknowledgement preserves actual changed bytes and shared uncertainty across restart without repeating the edit', (t) => {
  const f = fixture(t);
  f.configure({ concurrency: 1 });
  const d = f.import(),
    draft = f.draft(d, 'Output without acknowledgement'),
    input = f.human('/document apply ' + draft.draftId),
    write = f.documents.write.bind(f.documents);
  f.documents.write = (d, text) => {
    write(d, text);
    throw new Error('Synthetic lost output acknowledgement');
  };
  assert.throws(() => f.documents.apply(input, draft.draftId), /output is unconfirmed/);
  assert.equal(f.documents.read(d.id).text, 'Output without acknowledgement');
  assert.equal(f.documents.state.receipts[0].status, 'unconfirmed');
  assert.equal(f.budgets.state.entries[1].status, 'unknown');
  const budgets = new ResourceBudgets(f.budgetOptions),
    documents = new Documents({ ...f.documentOptions, budgets });
  t.after(() => budgets.close());
  assert.equal(budgets.accounting('global').concurrency, 1);
  assert.throws(() => documents.apply(input, draft.draftId), { code: 'DOCUMENT_REQUEST_HELD' });
  const spec = { file: f.source, title: 'New request held by uncertainty' };
  assert.throws(() => documents.import(f.human('/document import ' + JSON.stringify(spec)), spec), {
    code: 'RESOURCE_BUDGET',
  });
  assert.equal(documents.read(d.id).text, 'Output without acknowledgement');
  assert.equal(documents.state.receipts.length, 1);
  assert.equal(documents.state.documents.length, 1);
  assert.equal(budgets.state.entries.length, 2);
});
