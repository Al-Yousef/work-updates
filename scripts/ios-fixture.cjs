'use strict';
// Isolated synthetic TLS queue for Swift/Simulator tests. No Codex authentication or real chats.
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { Queue } = require('../src/queue.cjs');
const { Controller } = require('../src/controller.cjs');
const { Messages } = require('../src/messages.cjs');
const { DemoCodex, feed } = require('../src/demo.cjs');
const { HostPeer } = require('../src/peer.cjs');
const { StatePublisher } = require('../src/state-order.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-ios-fixture-'));
const codeFile =
  process.env.WU_TEST_CODE_FILE || path.join(os.tmpdir(), 'work-updates-ios-pairing-code');
const queue = new Queue(directory),
  client = new DemoCodex(),
  controller = new Controller(queue, client);
const messages = new Messages(queue,controller);
queue.setFeed(feed(), { ok: true });
const publisher = new StatePublisher();
const state = () =>
  publisher.stamp({
    ...messages.decorate(queue.snapshot()),
    host: { id: '11111111-1111-4111-8111-111111111111', name: 'Synthetic desktop', kind: 'mac' },
  });
const host = new HostPeer({
  commands:['create','start','send','action','undo','details','respond','refresh'],
  directory,
  encrypt: (v) => Buffer.from(v),
  decrypt: (v) => v.toString(),
  state,
  command: async (method, input) => {
    if (method === 'create') return queue.create(input);
    if (method === 'start') return controller.start(input.id);
    if (method === 'send')
      return messages.send(input);
    if (method === 'action') {
      queue.action(input.id, input.action, input.taskKey);
      return state();
    }
    if (method === 'undo') {
      queue.undoLast();
      return state();
    }
    if (method === 'details') return queue.get(input.id, input.taskKey);
    if (method === 'respond') return controller.respond(input.id, input.decision, input.answers);
    if (method === 'refresh') return state();
    throw new Error('Not supported by the synthetic fixture.');
  },
});
queue.on('change', () => host.broadcast(state()));
host
  .start('127.0.0.1')
  .then((code) => {
    fs.writeFileSync(codeFile, code, { mode: 0o600 });
    console.log('Synthetic iPhone TLS fixture ready. Pairing code is private and was not printed.');
  })
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
    close();
  });
function close() {
  host.close();
  messages.close();
  client.close();
  fs.rmSync(codeFile, { force: true });
  fs.rmSync(directory, { recursive: true, force: true });
}
process.once('SIGTERM', () => {
  close();
  process.exit(0);
});
process.once('SIGINT', () => {
  close();
  process.exit(0);
});
