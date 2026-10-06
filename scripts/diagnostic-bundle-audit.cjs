'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { seed } = require('../tests/fixtures/diagnostic-timeline.cjs');
const { DiagnosticLog, connectionHealth } = require('../src/diagnostics.cjs');
const { Messages } = require('../src/messages.cjs');
const directory = path.resolve(__dirname, '../artifacts/diagnostic-audit');
(async () => {
  const profile = path.join(directory, 'profile-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const { log, queue, intents } = await seed(profile),
    file = path.join(profile, 'messages.json'),
    state = JSON.parse(fs.readFileSync(file));
  state.entries.find((e) => e.id === intents.at(-1).messageId).status = 'sending';
  fs.writeFileSync(file, JSON.stringify(state));
  const restarted = new DiagnosticLog(log.directory, {
    protectedDirectory: profile,
    metadata: log.metadata,
  });
  const messages = new Messages(
    queue,
    {
      send: () => {
        throw new Error('Unexpected fixture redispatch');
      },
    },
    { auto: false, log: restarted },
  );
  messages.close();
  const preview = restarted.preview({
      health: connectionHealth({
        collectedAt: Date.now() / 1000,
        collector: { ok: true },
        helper: { connected: true },
        devices: [{ kind: 'pc', online: true }],
      }),
    }),
    destination = path.join(directory, 'diagnostic-bundle.json');
  const result = restarted.export(preview.previewId, destination),
    text = fs.readFileSync(destination, 'utf8'),
    bundle = JSON.parse(text),
    records = bundle.files.flatMap((f) => f.records);
  assert.ok(!/PRIVATE_FIXTURE|10000000-0000-4000-8000-000000000001|fixture-device/.test(text));
  const categories = [...new Set(records.map((r) => r.category).filter(Boolean))];
  for (const category of ['preparation-timeout', 'writer-unavailable', 'receipt-unknown'])
    assert.ok(categories.includes(category));
  const recovered = records.find((r) => r.event === 'message.recovered');
  assert.ok(
    records.some(
      (r) =>
        r.event === 'message.uncertain' &&
        r.messageId === recovered.messageId &&
        r.backendSessionId !== recovered.backendSessionId,
    ),
  );
  const report = {
    schema: 1,
    passed: true,
    synthetic: true,
    accountsUsed: 0,
    modelCalls: 0,
    dispatchesToCodex: 0,
    previewedFiles: preview.files,
    records: records.length,
    categories,
    bundleBytes: result.bytes,
    bundleSha256: result.sha256,
  };
  fs.writeFileSync(path.join(directory, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
