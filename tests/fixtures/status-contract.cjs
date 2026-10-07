'use strict';
const path = require('node:path');
const { Queue } = require('../../src/queue.cjs');
const { nativeView } = require('../../src/native-view.cjs');
const { projectStatus } = require('../../src/status-contract.cjs');
const { summaryKey } = require('../../src/summary-key.cjs');
const cases = [
  { id: 'waiting-you', status: 'needs', body: 'Waiting on you to confirm.', label: 'Waiting on you', waiting: 'you' },
  { id: 'waiting-reviewer', status: 'waiting', body: 'Waiting for the reviewer to respond.', label: 'Waiting on reviewer', waiting: 'other' },
  { id: 'waiting-system', status: 'waiting', body: 'Waiting on CI to complete.', label: 'Waiting on CI', waiting: 'other' },
  { id: 'waiting-unknown', status: 'waiting', body: 'Waiting for a response.', label: 'Waiting · owner unclear', waiting: 'unknown' },
  { id: 'running', status: 'working', label: 'Working' },
  { id: 'blocked', status: 'blocked', body: 'Still blocked; the fixture service is unavailable.', label: 'Blocked' },
  { id: 'completed', status: 'ready', label: 'Ready to review' },
  { id: 'queued', status: 'queued', label: 'Queued' },
  { id: 'offline', status: 'working', offline: true, expectedStatus: 'unknown', label: 'Offline · last known: Working' },
  { id: 'stale', status: 'working', age: 60, expectedStatus: 'unknown', label: 'Stale · last known: Working' },
  ...['cached', 'pending', 'failed', 'disabled', 'rate_limited'].map(summaryState => ({
    id: 'summary-' + summaryState, status: 'ready', summaryState, label: 'Ready to review',
  })),
];
function fixtures(directory) {
  const now = Date.now() / 1000;
  return cases.map(spec => {
    const queue = new Queue(path.join(directory, spec.id));
    const source = { id: spec.id, title: 'Chat ' + spec.id, taskTitle: 'Review fixture ' + spec.id,
      body: spec.body || 'A recorded fixture update.', status: spec.status,
      lifecycle: spec.status === 'working' ? 'working' : 'completed', updatedAt: now,
      turnId: spec.id + '-turn', fingerprint: spec.id + '-revision', contextLoaded: true,
      readyForReview: spec.status === 'ready', device: { kind: 'mac', label: 'Mac' } };
    queue.setFeed({ threads: spec.status === 'queued' ? [] : [source], collectedAt: now - (spec.age || 0), monitoredCount: 1 });
    if (spec.status === 'queued') queue.create({ title: source.taskTitle, prompt: 'A local queued fixture.' });
    queue.state.settings.aiSummaries = !!spec.summaryState && spec.summaryState !== 'disabled';
    if (spec.summaryState) queue.setSummaries(
      new Map(spec.summaryState === 'cached' ? [[summaryKey(source), { title: 'Grounded fixture title', summary: 'Grounded fixture summary.' }]] : []),
      { enabled: queue.state.settings.aiSummaries }, new Map([[summaryKey(source), spec.summaryState]]),
    );
    let card = queue.cards()[0];
    if (spec.offline) card = projectStatus({ ...card, owner: { id: 'fixture-owner', kind: 'mac', online: false, local: false } });
    const state = { ...queue.snapshot(), cards: [card] };
    const frame = nativeView(state);
    return { id: spec.id, expected: { status: spec.expectedStatus || spec.status,
      label: spec.label, waiting: spec.waiting, summaryState: spec.summaryState || 'disabled',
      deviceKind: spec.status === 'queued' ? (process.platform === 'win32' ? 'pc' : process.platform === 'darwin' ? 'mac' : 'linux') : 'mac',
      activity: (spec.expectedStatus || spec.status) === 'working' }, state, frame };
  });
}
module.exports = { fixtures };
