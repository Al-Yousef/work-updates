'use strict';
// Requires a separate human opt-in. All identity, quota and account evidence
// stays in the ignored private output; no existing chat is used as a fixture.
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  assert = require('node:assert/strict');
if (!process.argv.includes('--allow-disposable-reader-audit'))
  throw new Error(
    'Separate human authorization is required: create one disposable chat, use two synthetic source turns, read only that chat and archive it.',
  );
const root = path.resolve(__dirname, '..'),
  artifactRoot = path.join(root, 'artifacts'),
  directory = path.resolve(
    process.argv.find((a) => a.startsWith('--output='))?.slice(9) ||
      path.join(artifactRoot, 'research-account-' + Date.now()),
  );
if (
  !directory.startsWith(artifactRoot + path.sep) ||
  (fs.existsSync(directory) && fs.readdirSync(directory).length)
)
  throw new Error('Use a new empty private audit directory inside this checkout artifacts');
fs.mkdirSync(directory, { recursive: true });
const { Codex } = require('../src/codex.cjs'),
  { fixture } = require('../tests/fixtures/research-profile.cjs'),
  { reader } = require('../src/research-reader.cjs');
async function audit() {
  const client = new Codex({ requestTimeoutMs: 15000 }),
    f = fixture(),
    outcomes = new Map();
  let threadId,
    model,
    archived = false,
    toolRequested = false,
    dispatches = 0,
    reads = 0;
  client.on('request', (event) => {
    toolRequested = true;
    client.reject(event.id);
  });
  client.on('notification', (event) => {
    if (event.method === 'turn/completed' && event.params?.threadId === threadId)
      outcomes.set(event.params.turn.id, event.params.turn.status);
  });
  const wait = async (predicate) => {
    const end = Date.now() + 60000;
    while (!predicate()) {
      if (toolRequested) throw new Error('Unexpected tool request; audit stopped');
      if (Date.now() > end) throw new Error('Reader audit timed out; do not resend');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  try {
    await client.connect();
    const available = await client.call('model/list', { includeHidden: false });
    model = ['gpt-6-luna', 'gpt-5.6-luna'].find((id) => available.data.some((m) => m.model === id));
    assert.ok(model, 'A bounded audit model must be available');
    const { config: existing } = await client.call('config/read', { includeLayers: false }),
      config = {
        project_doc_max_bytes: 0,
        include_environment_context: false,
        include_apps_instructions: false,
        include_collaboration_mode_instructions: false,
        web_search: 'disabled',
        'tools.view_image': false,
        'agents.enabled': false,
        'features.code_mode.enabled': false,
      };
    for (const name of [
      'shell_tool',
      'unified_exec',
      'multi_agent',
      'apps',
      'hooks',
      'memories',
      'remote_plugin',
      'goals',
    ])
      config['features.' + name] = false;
    for (const id of Object.keys(existing.mcp_servers || {})) {
      config[`mcp_servers.${id}.enabled`] = false;
      config[`mcp_servers.${id}.required`] = false;
    }
    for (const id of Object.keys(existing.plugins || {})) config[`plugins.${id}.enabled`] = false;
    const instructions =
        'Disposable Hyphen original-reader audit. Respond only to synthetic text with its exact token. Never call tools, read files, use connectors or do external work.',
      started = await client.call('thread/start', {
        cwd: directory,
        model,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        baseInstructions: instructions,
        developerInstructions: instructions,
        config,
        serviceName: 'hyphen_research_audit',
      });
    threadId = started.thread.id;
    assert.ok(threadId);
    client.loaded.add(threadId);
    fs.writeFileSync(
      path.join(directory, 'private-audit-identity.json'),
      JSON.stringify({ threadId, createdByAudit: true }),
    );
    await client.call('thread/name/set', {
      threadId,
      name: 'Hyphen disposable original-reader audit',
    });
    f.source.id = threadId;
    f.source.title = 'Hyphen disposable original-reader audit';
    const actual = reader(),
      raw = actual.read;
    actual.read = async (request) => {
      assert.equal(request.scope.sourceId, threadId);
      reads++;
      return raw(request);
    };
    f.research.options.reader = actual;
    f.wall();
    const enabled = await f.enable({
        initialLookbackSeconds: 3600,
        incrementalLookbackSeconds: 3600,
        maxReads: 8,
        maxReadsPerDay: 8,
      }),
      id = enabled.researchId;
    assert.equal(enabled.status, 'completed', enabled.answer);
    const send = async (text) => {
      assert.ok(threadId);
      dispatches++;
      const receipt = await client.send(threadId, text, [], { messageId: crypto.randomUUID() }),
        turnId = receipt.turn?.id || receipt.turnId;
      assert.ok(turnId);
      await wait(() => outcomes.has(turnId) && !client.active.has(threadId));
      assert.equal(outcomes.get(turnId), 'completed');
    };
    await send(
      'This synthetic task remains open until its outcome is checked. Reply only RESEARCH_INITIAL_OK. Do not call tools.',
    );
    f.wall();
    await f.ask('/research read ' + id);
    const first = f.research.entry(id);
    assert.ok(first.records.some((r) => r.text.includes('RESEARCH_INITIAL_OK')));
    assert.ok(first.records.some((r) => r.role === 'user' && r.text.includes('remains open')));
    await send(
      'Correction: the synthetic task remains unverified. Reply only RESEARCH_LATER_OK. Do not call tools.',
    );
    f.wall();
    await f.ask('/research read ' + id);
    const second = f.research.entry(id);
    assert.ok(second.records.some((r) => r.role === 'user' && r.text.includes('Correction:')));
    assert.ok(
      second.records.some((r) => r.role === 'assistant' && r.text.includes('RESEARCH_LATER_OK')),
    );
    assert.equal(second.scans.at(-1).coverage.exhaustive, false);
    f.restart();
    assert.deepEqual(f.research.entry(id).records, second.records);
    await f.ask('/research revoke ' + id);
    await f.ask('/research read ' + id);
    assert.equal(reads, 2);
    assert.equal(dispatches, 2);
    assert.equal(toolRequested, false);
    await client.call('thread/archive', { threadId });
    archived = true;
    const report = {
      schema: 1,
      passed: true,
      mode: 'actual local Codex original reader',
      model,
      sourceModelTurns: 2,
      actualScopedReads: reads,
      originalRequestAndLaterCorrectionRead: true,
      cursorsSurvivedRestart: true,
      revocationPreventedFurtherReads: true,
      existingChatsTouched: 0,
      createdChats: 1,
      archived,
      assistantModelCalls: 0,
      connectorCalls: 0,
      installedAppChanged: false,
      limits:
        'Only an audit-created synthetic chat. Source owner metadata and assistant are fixtures. This verifies actual original-record access, not complete account coverage, general tool permissions, inferred assignments, outcome verification or physical input.',
    };
    fs.writeFileSync(path.join(directory, 'verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    return report;
  } catch (error) {
    fs.writeFileSync(
      path.join(directory, 'failure.json'),
      JSON.stringify({
        passed: false,
        error: error.message,
        createdAuditChat: !!threadId,
        archived,
        dispatches,
        reads,
        needsHumanReview: !!threadId && !archived,
      }),
    );
    throw error;
  } finally {
    if (threadId && !archived)
      try {
        await client.call('thread/archive', { threadId });
        archived = true;
        fs.writeFileSync(path.join(directory, 'cleanup.json'), JSON.stringify({ archived: true }));
      } catch {
        fs.writeFileSync(
          path.join(directory, 'cleanup.json'),
          JSON.stringify({ archived: false, needsHumanReview: true }),
        );
      }
    f.close();
    client.close();
  }
}
audit().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
