'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto'),
  assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { Queue } = require('../src/queue.cjs'),
  { Messages } = require('../src/messages.cjs'),
  { Assistant } = require('../src/assistant.cjs'),
  { Responsibilities } = require('../src/responsibilities.cjs'),
  { feed } = require('../src/demo.cjs');
const { outcome } = require('../src/assistant-coordination.cjs'),
  target = require('../src/responsibility-target.cjs'),
  { atomicJSON } = require('../src/private-store.cjs');
async function audit() {
  const root = path.resolve(__dirname, '..'),
    reportFile = path.join(root, 'artifacts/responsibility-audit/verification.json');
  fs.rmSync(reportFile, { force: true });
  const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    sourceDirty = !!execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
  if (process.argv.includes('--require-clean') && sourceDirty)
    throw new Error('Responsibility CI requires a clean source revision');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-responsibility-audit-')),
    nonce = crypto.randomBytes(16).toString('hex');
  let messages, assistant, responsibilities;
  let dispatches = 0,
    workers = 0,
    modelCalls = 0;
  try {
    const queue = new Queue(directory);
    queue.setFeed(feed());
    const instruction =
      'Prepare the owned synthetic result with verified=true and its audit nonce.';
    messages = new Messages(
      queue,
      {
        send: async (id, text, source, key, input) => {
          assert.equal(text, instruction);
          const saved = JSON.parse(fs.readFileSync(path.join(directory, 'responsibilities.json')))
            .entries[0];
          assert.equal(saved.currentStep.messageId, input.messageId);
          assert.equal(saved.currentStep.status, 'queued');
          workers++;
          execFileSync(
            process.execPath,
            [path.join(root, 'tests/fixtures/responsibility-worker.cjs'), directory, nonce],
            { stdio: 'pipe', timeout: 10000 },
          );
          dispatches++;
          return {
            messageId: input.messageId,
            sourceId: source,
            turnId: 'synthetic-owned-worker-turn',
            route: 'synthetic worker',
          };
        },
      },
      { auto: false },
    );
    const snapshot = () => {
      const state = messages.decorate(queue.snapshot());
      state.cards = state.cards.map((c) => ({
        ...c,
        chatName: c.chatName || c.title,
        owner: { id: 'audit-pc', name: 'Audit PC', kind: 'pc', online: true },
      }));
      return state;
    };
    const dispatch = async (mode, input) => ({
      ...(await (mode === 'cancel'
        ? messages.cancel(input.messageId, input.sourceId)
        : mode === 'queue'
          ? messages.enqueue(input)
          : messages.send(input))),
      ownerId: 'audit-pc',
    });
    const options = {
      directory,
      snapshot,
      ...target,
      outcome,
      dispatch,
      cancel: (input) => dispatch('cancel', input),
    };
    responsibilities = new Responsibilities(options);
    assistant = new Assistant({
      directory,
      snapshot,
      responsibilities,
      dispatch,
      provider: {
        async answer() {
          modelCalls++;
          throw new Error('No model is needed for this fixture');
        },
        close() {},
      },
    });
    const card = snapshot().cards[0],
      source = queue.feed.threads.find((s) => s.id === card.primarySourceId);
    assistant.focus(card);
    const messageId = crypto.randomUUID();
    assistant.ask({ messageId, text: 'Keep working in this chat: ' + instruction });
    await assistant.work;
    const request = assistant.state.messages.find((m) => m.id === messageId);
    assert.equal(request.status, 'completed');
    const id = request.responsibilityId,
      intent = responsibilities.entry(id).currentStep.messageId;
    responsibilities.close();
    responsibilities = new Responsibilities(options);
    assistant.options.responsibilities = responsibilities;
    await responsibilities.pump();
    assert.equal(dispatches, 0);
    source.lifecycle = 'completed';
    await messages.pump();
    responsibilities.observe(snapshot());
    assert.equal(dispatches, 1);
    assert.equal(responsibilities.entry(id).currentStep.messageId, intent);
    assert.equal(responsibilities.entry(id).currentStep.status, 'accepted');
    source.turnId = 'obsolete-turn';
    source.turnOutcome = 'completed';
    responsibilities.observe(snapshot());
    assert.equal(responsibilities.entry(id).state, 'waiting_external');
    source.turnId = 'synthetic-owned-worker-turn';
    responsibilities.observe(snapshot());
    assert.equal(responsibilities.entry(id).state, 'waiting_user');
    // The fixture verifies its independently created artifact before supplying
    // a synthetic human confirmation; a worker exit or receipt alone is insufficient.
    const bytes = fs.readFileSync(path.join(directory, 'requested-result.json')),
      result = JSON.parse(bytes);
    assert.deepEqual(result, { schema: 1, verified: true, nonce });
    responsibilities.confirm(id, {
      role: 'human',
      messageId: crypto.randomUUID(),
      text: 'The audit fixture verified the requested owned artifact.',
    });
    assert.equal(responsibilities.entry(id).state, 'completed');
    await responsibilities.pump();
    await messages.pump();
    assert.equal(dispatches, 1);
    assert.equal(workers, 1);
    assert.equal(modelCalls, 0);
    const report = {
      schema: 1,
      passed: true,
      synthetic: true,
      sourceRevision,
      sourceDirty,
      sourceTransport: 'owned synthetic worker',
      assistantAnswerProvider: 'fixture; not invoked',
      actualWorkerProcesses: workers,
      actualResultArtifact: true,
      resultSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      dispatches,
      restartReplayPrevented: true,
      obsoleteTurnRefused: true,
      workerExitAloneInsufficient: true,
      verificationActor: 'synthetic human fixture after independent artifact check',
      accountsUsed: 0,
      modelCalls,
      existingChatsTouched: 0,
      installedAppChanged: false,
    };
    atomicJSON(reportFile, report);
    console.log(JSON.stringify(report));
    return report;
  } finally {
    assistant?.close();
    responsibilities?.close();
    messages?.close();
    const resolved = path.resolve(directory);
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith('hyphen-responsibility-audit-')
    )
      throw new Error('Owned cleanup target escaped its temporary root');
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
if (require.main === module)
  audit().catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  });
module.exports = { audit };
