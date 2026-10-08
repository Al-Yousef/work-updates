'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto'),
  assert = require('node:assert/strict'),
  { execFileSync } = require('node:child_process');
const { Queue } = require('../src/queue.cjs'),
  { Messages } = require('../src/messages.cjs'),
  { Responsibilities } = require('../src/responsibilities.cjs'),
  { Schedules } = require('../src/schedules.cjs'),
  { Assistant } = require('../src/assistant.cjs'),
  { feed } = require('../src/demo.cjs');
const target = require('../src/responsibility-target.cjs'),
  bridge = require('../src/scheduled-responsibility.cjs'),
  { outcome } = require('../src/assistant-coordination.cjs'),
  { atomicJSON } = require('../src/private-store.cjs');
async function audit({ preparationDelayMs = 0 } = {}) {
  assert.ok(Number.isSafeInteger(preparationDelayMs) && preparationDelayMs >= 0 && preparationDelayMs <= 5000);
  const root = path.resolve(__dirname, '..'),
    reportFile = path.join(root, 'artifacts/schedule-audit/verification.json');
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
    throw new Error('Scheduler CI requires clean source');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-responsibility-audit-schedule-')),
    nonce = crypto.randomBytes(16).toString('hex');
  let messages,
    responsibilities,
    schedules,
    assistant,
    workerProcesses = 0,
    sourceDispatches = 0,
    admissions = 0,
    modelCalls = 0,
    timerStartedAt = null;
  // Hold the fixture clock while creating the schedule. Disk writes must not
  // consume its future deadline before the real polling timer is started.
  const scheduleEpoch = Date.now();
  try {
    const queue = new Queue(directory);
    queue.setFeed(feed());
    const instruction =
      'Prepare the owned synthetic result with verified=true and its audit nonce.';
    messages = new Messages(
      queue,
      {
        send: async (id, text, source, key, input) => {
          require('../src/dispatch-deadline.cjs').admission(input);
          assert.equal(text, instruction);
          const persisted = JSON.parse(
              fs.readFileSync(path.join(directory, 'responsibilities.json')),
            ).entries[0],
            journal = JSON.parse(fs.readFileSync(path.join(directory, 'schedules.json')))
              .entries[0];
          assert.equal(persisted.currentStep.messageId, input.messageId);
          assert.equal(journal.runs[0].messageId, input.messageId);
          assert.equal(journal.runs[0].status, 'queued');
          assert.ok(Date.now() <= input.expiresAt);
          workerProcesses++;
          execFileSync(
            process.execPath,
            [path.join(root, 'tests/fixtures/responsibility-worker.cjs'), directory, nonce],
            { stdio: 'pipe', timeout: 10000 },
          );
          sourceDispatches++;
          return {
            messageId: input.messageId,
            sourceId: source,
            turnId: 'owned-scheduled-worker-turn',
          };
        },
      },
      {
        auto: false,
        admission: (message) => bridge.admission(responsibilities, schedules, message),
      },
    );
    const snapshot = () => {
      const state = messages.decorate(queue.snapshot());
      state.cards = state.cards.map((c) => ({
        ...c,
        chatName: c.chatName || c.title,
        owner: { id: 'audit-pc', name: 'Audit PC', kind: 'pc', online: true, local: true },
      }));
      return state;
    };
    responsibilities = new Responsibilities({
      directory,
      snapshot,
      ...target,
      outcome,
      dispatch: async (mode, input) => ({ ...messages.enqueue(input), ownerId: 'audit-pc' }),
    });
    const options = {
      directory,
      pollMs: 20,
      now: () => scheduleEpoch + (timerStartedAt === null ? 0 : Date.now() - timerStartedAt),
      probe: (entry) => bridge.probe(responsibilities, entry),
      run: (entry) => {
        admissions++;
        return bridge.run(responsibilities, entry);
      },
      outcome: (entry, run) => bridge.outcome(responsibilities, entry, run),
    };
    schedules = new Schedules(options);
    assistant = new Assistant({
      directory,
      snapshot,
      responsibilities,
      schedules,
      provider: {
        async answer() {
          modelCalls++;
          throw new Error('No model is needed');
        },
        close() {},
      },
    });
    const card = snapshot().cards[0],
      source = queue.feed.threads.find((s) => s.id === card.primarySourceId),
      scope = target.currentScope({ sourceId: source.id, ownerId: 'audit-pc' }, snapshot());
    const id = responsibilities.create(
        { role: 'human', messageId: crypto.randomUUID(), text: instruction },
        scope,
        {
          kind: 'human_verified',
          description: 'The fixture independently reviews the requested artifact',
        },
      ),
      wake = scheduleEpoch + 350,
      end = scheduleEpoch + 60000,
      messageId = crypto.randomUUID();
    if (preparationDelayMs) await new Promise((resolve) => setTimeout(resolve, preparationDelayMs));
    assistant.ask({
      messageId,
      text:
        '/schedule start ' +
        id +
        ' deadline ' +
        new Date(wake).toISOString() +
        ' every 1m zone America/Toronto until ' +
        new Date(end).toISOString() +
        ' runs 1 checks 4',
    });
    await assistant.work;
    const request = assistant.state.messages.find((m) => m.id === messageId);
    assert.equal(request.status, 'completed', request.error);
    const scheduleId = request.scheduleId;
    assert.equal(schedules.entry(scheduleId).runs.length, 0);
    timerStartedAt = Date.now();
    schedules.start();
    const wait = async (check) => {
      const limit = Date.now() + 5000;
      while (!check()) {
        if (Date.now() > limit) throw new Error('Owned schedule timer did not wake');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    await wait(() => schedules.entry(scheduleId).runs[0]?.status === 'queued');
    const original = schedules.entry(scheduleId).runs[0];
    assert.equal(admissions, 1);
    assert.equal(sourceDispatches, 0);
    assert.equal(schedules.entry(scheduleId).lastActualRun, null);
    schedules.close();
    schedules = new Schedules(options);
    assistant.options.schedules = schedules;
    schedules.start();
    await schedules.tick();
    assert.equal(admissions, 1);
    assert.equal(messages.state.entries.length, 1);
    source.lifecycle = 'completed';
    await messages.pump();
    responsibilities.observe(snapshot());
    schedules.observe();
    const accepted = schedules.entry(scheduleId).runs[0];
    assert.equal(accepted.id, original.id);
    assert.equal(accepted.messageId, original.messageId);
    assert.equal(accepted.status, 'accepted');
    assert.ok(accepted.acceptedAt >= accepted.plannedAt);
    source.turnId = 'owned-scheduled-worker-turn';
    source.turnOutcome = 'completed';
    responsibilities.observe(snapshot());
    await schedules.tick();
    assert.equal(schedules.entry(scheduleId).runs[0].status, 'completed');
    assert.equal(schedules.entry(scheduleId).state, 'expired');
    assert.equal(responsibilities.entry(id).state, 'waiting_user');
    const bytes = fs.readFileSync(path.join(directory, 'requested-result.json'));
    assert.deepEqual(JSON.parse(bytes), { schema: 1, verified: true, nonce });
    responsibilities.confirm(id, {
      role: 'human',
      messageId: crypto.randomUUID(),
      text: 'The fixture independently verified the requested result file.',
    });
    await schedules.tick();
    await messages.pump();
    assert.equal(admissions, 1);
    assert.equal(sourceDispatches, 1);
    assert.equal(workerProcesses, 1);
    assert.equal(modelCalls, 0);
    const report = {
      schema: 1,
      passed: true,
      synthetic: true,
      sourceRevision,
      sourceDirty,
      timerWokeRun: true,
      fixtureClockHeldDuringPreparation: true,
      preparationDelayMs,
      runTrigger: accepted.trigger,
      namedTimeZone: schedules.entry(scheduleId).schedule.timeZone,
      plannedAt: accepted.plannedAt,
      actualAcceptedAt: accepted.acceptedAt,
      queuedBeforeActualRun: true,
      sourceAcceptanceTimestampRecorded: true,
      restartPreventedReadmission: true,
      actualWorkerProcesses: workerProcesses,
      sourceDispatches,
      actualResultArtifactVerified: true,
      resultSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      runLimitPreventedAnotherDispatch: true,
      accountsUsed: 0,
      modelCalls,
      installedAppChanged: false,
      limits:
        'Own synthetic worker transport and human verification fixture. The fixture clock is held during preparation, then advances with the real polling timer; no real Codex account, physical input or OS wake-from-shutdown evidence.',
    };
    atomicJSON(reportFile, report);
    console.log(JSON.stringify(report));
    return report;
  } finally {
    assistant?.close();
    schedules?.close();
    responsibilities?.close();
    messages?.close();
    const resolved = path.resolve(directory);
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith('hyphen-responsibility-audit-schedule-')
    )
      throw new Error('Owned schedule cleanup escaped its temporary root');
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
if (require.main === module)
  audit().catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  });
module.exports = { audit };
