'use strict';
// Isolated synthetic TLS queue for Swift/Simulator tests. No Codex authentication or real chats.
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { Queue } = require('../src/queue.cjs');
const { Controller } = require('../src/controller.cjs');
const { DemoCodex, feed } = require('../src/demo.cjs');
const { HostPeer } = require('../src/peer.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-ios-fixture-'));
const codeFile = path.join(os.tmpdir(), 'work-updates-ios-pairing-code');
const queue = new Queue(directory),
  client = new DemoCodex(),
  controller = new Controller(queue, client);
queue.setFeed(feed(), { ok: true });
const state = () => ({
  ...queue.snapshot(),
  protocolVersion: 2,
  host: { id: '11111111-1111-4111-8111-111111111111', name: 'Synthetic desktop', kind: 'mac' },
  servedAt: Math.floor(Date.now() / 1000),
});
const host = new HostPeer({
  directory,
  encrypt: (v) => Buffer.from(v),
  decrypt: (v) => v.toString(),
  state,
  command: async (method, input) => {
    if (method === 'create') return queue.create(input);
    if (method === 'start') return controller.start(input.id);
    if (method === 'send')
      return controller.send(input.id, input.text, input.sourceId, input.taskKey);
    if (method === 'action') return queue.action(input.id, input.action, input.taskKey);
    if (method === 'undo') return queue.undoLast();
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
