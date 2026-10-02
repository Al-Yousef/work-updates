'use strict';
// Explicit opt-in. Creates one harmless chat using your signed-in Codex account.
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  assert = require('node:assert/strict');
const { Queue } = require('../src/queue.cjs'),
  { Codex } = require('../src/codex.cjs'),
  { Controller } = require('../src/controller.cjs');
if (!process.argv.includes('--confirm'))
  throw new Error('This check creates one Codex chat. Run with --confirm to opt in.');
const dir =
  process.env.WORK_UPDATES_SMOKE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'wu-live-'));
const queue = new Queue(dir),
  client = new Codex(),
  controller = new Controller(queue, client);
function completed(task) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      queue.removeListener('change', changed);
      reject(new Error('No completed pass arrived within 90 seconds.'));
    }, 90000);
    function changed() {
      if (['ready', 'blocked', 'needs', 'waiting'].includes(task.status)) {
        clearTimeout(timer);
        queue.removeListener('change', changed);
        task.status === 'ready'
          ? resolve()
          : reject(new Error(task.error || 'Codex did not finish the smoke check.'));
      }
    }
    queue.on('change', changed);
    changed();
  });
}
(async () => {
  try {
    const task = queue.create({
      title: 'Work Updates connection check',
      prompt:
        'Reply exactly: Work Updates connection verified. Do not use tools, open files, or make changes.',
    });
    await controller.start(task.id);
    await completed(task);
    assert.ok(task.threadId);
    assert.match(
      task.messages.filter((m) => m.role === 'assistant').at(-1).text,
      /Work Updates connection verified/,
    );
    const id = task.threadId;
    await controller.send(
      task.id,
      'Reply exactly: Work Updates follow-up verified. Do not use tools or make changes.',
    );
    await completed(task);
    assert.equal(task.threadId, id);
    assert.match(
      task.messages.filter((m) => m.role === 'assistant').at(-1).text,
      /Work Updates follow-up verified/,
    );
    queue.action(task.id, 'done');
    assert.equal(queue.get(task.id).done, true);
    process.stdout.write(
      'Live Codex check: dedicated chat, completion, same-chat reply and Done passed.\n',
    );
  } finally {
    client.close();
  }
})().catch((error) => {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
});
