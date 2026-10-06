'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Queue, now } = require('../src/queue.cjs');
const { taskSource } = require('../src/task-source.cjs');
test('a detached task follows recorded chat status and context while preserving local review and snooze', (t) => {
  const q = model(t);
  q.feed.threads[0].contextLoaded = true;
  const task = q.create({ title: 'Old task', prompt: 'Old request' });
  q.patch(task.id, { threadId: 'sample-chat', status: 'blocked', error: 'Codex disconnected' });
  q.message(task.id, 'assistant', 'Old local context');
  const observed = q.feed.threads[0];
  Object.assign(observed, {
    status: 'working',
    lifecycle: 'working',
    body: 'Current recorded work.',
    summary: 'Current recorded work.',
    taskTitle: 'Current request',
    turnId: 'source-pass',
  });
  let card = q.get(task.id);
  assert.equal(card.status, 'working');
  assert.equal(card.summary, observed.summary);
  assert.equal(card.sources[0].body, observed.body);
  assert.equal(card.kind, 'observed');
  assert.equal(card.messages.length, 0);
  assert.equal(card.taskKey, task.id);
  assert.ok(card.replyError.includes('connection closed'));
  assert.equal(task.error, 'Codex disconnected');
  Object.assign(observed, { status: 'ready', lifecycle: 'completed', readyForReview: true });
  q.action(task.id, 'reviewed');
  assert.equal(q.get(task.id).reviewed, true);
  observed.fingerprint = 'next-pass';
  assert.equal(q.get(task.id).reviewed, false);
  q.action(task.id, 'snooze');
  assert.equal(q.get(task.id).snoozed, true);
  q.ownedThreads.add('sample-chat');
  q.patch(task.id, { status: 'working', error: '' });
  card = q.get(task.id);
  assert.equal(card.kind, 'local');
  assert.equal(card.taskKey, task.id);
  assert.equal(card.status, 'working');
});
test('a completed pass needing a user decision survives restart and can be marked Done', (t) => {
  const q = model(t),
    task = q.create({ title: 'Choose a draft', prompt: 'Ask for a choice.' });
  q.patch(task.id, {
    threadId: 'owned-chat',
    status: 'needs',
    turnId: 'pass',
    notificationVersion: 'pass',
    completedAt: now(),
  });
  q.save();
  const reloaded = new Queue(q.directory);
  assert.equal(reloaded.get(task.id).status, 'needs');
  assert.equal(reloaded.get(task.id).readyForReview, true);
  reloaded.action(task.id, 'done');
  assert.equal(reloaded.get(task.id).done, true);
});
test('owners and urgency survive reload without changing completion fingerprints', (t) => {
  const q = model(t);
  q.action('sample-chat', 'owner:Reviewer');
  q.action('sample-chat', 'priority:urgent');
  const fresh = new Queue(q.directory);
  fresh.setFeed(q.feed);
  assert.equal(fresh.get('sample-chat').label, 'Waiting on Reviewer');
  assert.equal(fresh.get('sample-chat').urgent, true);
  assert.equal(fresh.get('sample-chat').fingerprint, 'sample-chat:pass-one');
  fresh.action('sample-chat', 'status:needs');
  assert.equal(fresh.get('sample-chat').label, 'Waiting on you');
  fresh.action('sample-chat', 'status:auto');
  assert.equal(fresh.get('sample-chat').label, 'Ready to review');
});
test('a grouped chat surfaces its waiting-on-you source before a newer finished source', (t) => {
  const q = model(t);
  q.feed.device = { kind: 'mac' };
  q.feed.threads.push({
    ...q.feed.threads[0],
    id: 'needs-chat',
    title: 'Approval chat',
    device: { kind: 'pc' },
    taskTitle: 'Approve the draft',
    body: 'Still blocked on your approval.',
    status: 'blocked',
    updatedAt: now() - 30,
  });
  q.group({ title: 'Launch', ids: ['sample-chat', 'needs-chat'] });
  const card = q.cards()[0];
  assert.equal(card.title, 'Approve the draft');
  assert.equal(card.chatName, 'Approval chat');
  assert.equal(card.groupName, 'Launch');
  assert.equal(card.summary, 'Still blocked on your approval.');
  assert.equal(card.device.kind, 'pc');
  assert.equal(taskSource(card, 'sample-chat').device.kind, 'mac');
  assert.equal(card.waitingOn.kind, 'you');
  assert.equal(card.label, 'Waiting on you · blocked');
  assert.equal(taskSource(card).id, 'needs-chat');
  assert.equal(taskSource(card, 'sample-chat').id, 'sample-chat');
  assert.throws(() => taskSource(card, 'unrelated-chat'));
});
test('groups preserve source chats, can be edited and undone without losing queued tasks', (t) => {
  const q = model(t);
  q.feed.threads.push({
    ...q.feed.threads[0],
    id: 'second-chat',
    title: 'Desktop app',
    taskTitle: 'Check installer',
  });
  q.group({ title: 'Release planning', ids: ['sample-chat', 'second-chat'] });
  const group = q.state.groups[0];
  assert.equal(q.cards().length, 1);
  assert.equal(q.get(group.id).sources.length, 2);
  const task = q.create({ title: 'Follow-up checks', prompt: 'Verify the sample release.' });
  q.group({ id: group.id, title: 'Launch review', ids: group.threads });
  assert.equal(q.state.groups[0].title, 'Launch review');
  q.undoLast();
  assert.equal(q.state.groups[0].title, 'Release planning');
  assert.ok(q.get(task.id));
  q.group({ id: group.id, action: 'remove' });
  assert.equal(q.cards().length, 3);
  assert.throws(() => q.group({ title: 'Invalid', ids: ['sample-chat', 'unknown'] }));
});
test('manual chat status is reversible and returning to Automatic follows the feed', (t) => {
  const q = model(t);
  q.action('sample-chat', 'status:waiting');
  assert.equal(q.get('sample-chat').status, 'waiting');
  q.feed.threads[0].status = 'blocked';
  assert.equal(q.get('sample-chat').status, 'waiting');
  q.action('sample-chat', 'status:auto');
  assert.equal(q.get('sample-chat').status, 'blocked');
  q.undoLast();
  assert.equal(q.get('sample-chat').status, 'waiting');
});
function model(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-updates-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const q = new Queue(dir);
  q.setFeed({
    monitoredCount: 1,
    collectedAt: now(),
    threads: [
      {
        id: 'sample-chat',
        title: 'Launch planning',
        taskTitle: 'Prepare launch notes',
        fingerprint: 'pass-one',
        status: 'ready',
        readyForReview: true,
        updatedAt: now(),
        completedAt: now(),
        body: 'The draft is ready.',
      },
    ],
  });
  return q;
}
test('owned image messages remain visible while observed history catches up, preserving repeated messages',t=>{
  const q=model(t),at=now(),image={id:'image.png',path:'C:/private/image.png'};
  q.feed.threads[0].conversation=[{role:'user',text:'Repeat',at:at-30},{role:'user',text:'Repeat',at:at-20},{role:'user',text:'Same message',at}];
  const task=q.create({title:'Launch',prompt:'Continue'});q.patch(task.id,{threadId:'sample-chat',status:'working'});q.ownedThreads.add('sample-chat');
  q.message(task.id,'user','Same message','same-id',[image]);q.message(task.id,'user','New image','new-id',[image]);
  const messages=q.get(task.id).sources[0].conversation;
  assert.equal(messages.filter(m=>m.text==='Repeat').length,2);assert.equal(messages.filter(m=>m.text==='Same message').length,1);
  assert.equal(messages.find(m=>m.text==='Same message').images[0].path,image.path);assert.equal(messages.at(-1).text,'New image');assert.equal(messages.at(-1).images[0].id,image.id);
  q.feed.threads[0].contextLoaded=true;q.ownedThreads.clear();
  assert.equal(q.get(task.id).sources[0].conversation.at(-1).images[0].path,image.path);
});
test('Done closes the task across new passes, Reviewed only clears an update', (t) => {
  const q = model(t);
  q.action('sample-chat', 'reviewed');
  assert.equal(q.get('sample-chat').reviewed, true);
  q.feed.threads[0].fingerprint = 'pass-two';
  assert.equal(q.get('sample-chat').reviewed, false);
  q.action('sample-chat', 'done');
  q.feed.threads[0].fingerprint = 'pass-three';
  assert.equal(q.get('sample-chat').done, true);
  q.feed.threads[0].taskTitle = 'Prepare release checklist';
  assert.equal(q.get('sample-chat').done, false);
  assert.equal(q.snapshot().done.length, 1);
});
test('Done can be undone and reopened without losing newly queued work', (t) => {
  const q = model(t);
  q.action('sample-chat', 'done');
  const newTask = q.create({ title: 'Check installer', prompt: 'Verify the sample installer.' });
  q.undoLast();
  assert.equal(q.get('sample-chat').done, false);
  assert.ok(q.get(newTask.id));
  q.action('sample-chat', 'done');
  q.action('sample-chat', 'reopen');
  assert.equal(q.get('sample-chat').done, false);
});
test('queued tasks survive a restart, snooze survives updates, and starting cannot be marked done', (t) => {
  const q = model(t),
    task = q.create({ title: 'Check installer', prompt: 'Verify the sample installer.' });
  q.action(task.id, 'snooze');
  q.patch(task.id, { status: 'working', notificationVersion: 'new' });
  assert.equal(q.get(task.id).snoozed, true);
  assert.throws(() => q.action(task.id, 'done'));
  q.patch(task.id, { status: 'ready' });
  q.action(task.id, 'done');
  const restored = new Queue(q.directory);
  assert.equal(restored.get(task.id).status, 'done');
  restored.action(task.id, 'reopen');
  assert.equal(restored.get(task.id).status, 'queued');
});
test('titles change without changing the observed chat link or review fingerprint', (t) => {
  const q = model(t);
  q.action('sample-chat', 'reviewed');
  q.feed.threads[0].taskTitle = 'Review launch notes';
  const c = q.get('sample-chat');
  assert.equal(c.title, 'Review launch notes');
  assert.equal(c.sources[0].id, 'sample-chat');
  assert.equal(c.sources[0].title, 'Launch planning');
  assert.equal(c.reviewed, true);
});
test('summaries and executor metadata update without replaying a reviewed notification', (t) => {
  const q = model(t);
  q.feed.device = { kind: 'mac' };
  q.action('sample-chat', 'reviewed');
  const before = q.get('sample-chat');
  q.feed.threads[0].summary = 'The build passed. Waiting for final review.';
  const after = q.get('sample-chat');
  assert.equal(after.summary, 'The build passed. Waiting for final review.');
  assert.equal(after.device.kind, 'mac');
  assert.equal(after.reviewed, true);
  assert.equal(after.taskKey, before.taskKey);
  assert.equal(after.fingerprint, before.fingerprint);
  delete q.feed.device;
  assert.equal(q.get('sample-chat').device.kind, 'unknown');
});
test('an app-owned summary does not report an old completion while a new reply is working', (t) => {
  const q = model(t),
    task = q.create({ title: 'Verify installer', prompt: 'Check the installed application.' });
  q.message(task.id, 'assistant', 'The previous pass is ready.');
  q.message(task.id, 'user', 'Check the updated build.');
  q.patch(task.id, { status: 'working' });
  assert.equal(q.get(task.id).summary, 'Working on your latest message.');
  q.message(task.id, 'assistant', '**Current check:** The build is still running.');
  assert.equal(q.get(task.id).summary, 'Current check: The build is still running.');
  q.patch(task.id, { status: 'blocked', error: 'The chat disconnected. Retry to continue.' });
  assert.equal(
    q.get(task.id).summary,
    'The Codex connection closed. Open chat to check its progress.',
  );
  q.patch(task.id, {
    error: 'thread 10000000-0000-4000-8000-000000000001 already has an active writer',
  });
  assert.equal(
    q.get(task.id).summary,
    'Another Codex process owns this chat. Use Open chat to reply there.',
  );
});
test('a stale task identity cannot complete or open the new task in the same chat', (t) => {
  const q = model(t),
    before = q.get('sample-chat');
  q.feed.threads[0].taskTitle = 'Prepare a different release';
  assert.throws(() => q.get(before.id, before.taskKey), /task changed/);
  assert.throws(() => q.action(before.id, 'done', before.taskKey), /task changed/);
  assert.equal(q.snapshot().done.length, 0);
});
test('queue creation rejects blank and oversized prompts', (t) => {
  const q = model(t);
  assert.throws(() => q.create({ title: '', prompt: 'hello' }));
  assert.throws(() => q.create({ title: 'hello', prompt: 'x'.repeat(12001) }));
});
test('reopening a historic done item queues its own task without changing the new task in that chat', (t) => {
  const q = model(t);
  q.action('sample-chat', 'done');
  const old = q.snapshot().done[0];
  q.feed.threads[0].taskTitle = 'Prepare release checklist';
  q.action(old.taskKey, 'reopen');
  assert.equal(q.snapshot().done.length, 0);
  assert.equal(q.state.tasks[0].title, old.title);
  assert.equal(q.get('sample-chat').title, 'Prepare release checklist');
  q.undoLast();
  assert.equal(q.state.tasks.length, 0);
  assert.equal(q.snapshot().done.length, 1);
});
