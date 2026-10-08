'use strict';
// Loaded only by the isolated benchmark's own Electron child, never main.cjs.
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const directory = path.resolve(process.env.HYPHEN_PERFORMANCE_RUN || '');
const dataAt = process.argv.indexOf('--data-dir');
if (
  !process.argv.includes('--demo') ||
  dataAt < 0 ||
  path.resolve(process.argv[dataAt + 1]) !== path.join(directory, 'profile') ||
  !fs.existsSync(path.join(directory, 'source', 'state_5.sqlite'))
)
  throw new Error(
    'Performance preload requires its exact disposable demo profile and synthetic source',
  );
const { startObserver } = require('../src/observer.cjs');
const demo = require('../src/demo.cjs');
const { NativeControl } = require('../src/native-control.cjs');
const { AssistantProvider } = require('../src/assistant-provider.cjs');
AssistantProvider.prototype.answer = async () => ({
  answer: 'Synthetic performance fixture',
  links: [],
  action: null,
  model: 'fixture',
});
let queue,
  stream = null,
  reconnect = null,
  control = null,
  watch = null,
  overlay = {},
  lastId = '';
demo.startDemoObserver = function (value) {
  queue = value;
  let observer;
  observer = startObserver(
    path.join(directory, 'observer'),
    {
      codexHome: path.join(directory, 'source'),
      pollSeconds: 3,
      python: process.env.WORK_UPDATES_PYTHON,
      log: { write(type, value) {
        if (type === 'observer.exited') fs.writeFileSync(
          path.join(directory, 'collector-exit.json'), JSON.stringify({
            schema: 1, pid: value.pid, session: value.session, exitCode: value.exitCode,
            signal: value.signal, intentional: value.intentional,
            evidence: 'exit event from original owned collector ChildProcess',
          }));
      } },
    },
    (feed, health) => {
      if (!feed) return;
      queue.setFeed(feed, health);
      fs.writeFileSync(
        path.join(directory, 'performance-ready.json'),
        JSON.stringify({
          schema: 1,
          synthetic: true,
          backendPid: process.pid,
          collectorPid: observer?.pid || null,
          collectorSession: observer?.session || null,
          chatCount: queue.feed.threads.length,
        }),
      );
    },
  );
  const close = observer.close.bind(observer);
  observer.close = () => {
    clearInterval(stream);
    clearInterval(reconnect);
    watch?.close();
    return close();
  };
  watch = fs.watch(directory, (_, file) => {
    if (String(file) !== 'performance-command.json') return;
    let command;
    try {
      command = JSON.parse(
        fs.readFileSync(path.join(directory, 'performance-command.json'), 'utf8'),
      );
    } catch {
      return;
    }
    if (!command.id || command.id === lastId) return;
    lastId = command.id;
    clearInterval(stream);
    clearInterval(reconnect);
    stream = null;
    reconnect = null;
    overlay = {};
    if (['active_stream', 'navigation_reconnect_soak'].includes(command.phase))
      stream = setInterval(() => {
        const feed = structuredClone(queue.feed);
        feed.collectedAt = Date.now() / 1000;
        if (feed.threads[0])
          Object.assign(feed.threads[0], {
            body: 'Synthetic live stream ' + crypto.randomUUID(),
            lifecycle: 'working',
            updatedAt: Date.now() / 1000,
            fingerprint: crypto.randomUUID(),
          });
        queue.setFeed(feed, { ok: true, synthetic: true });
      }, 200);
    if (command.phase === 'navigation_reconnect_soak') {
      let cycles = 0, observedReconnections = 0, priorSubscriptions = null;
      const originalOwner = control?.owner;
      reconnect = setInterval(() => {
        // The corner lease is deliberately kept alive. Losing that lease
        // makes the native shell exit by design; only its queue subscription
        // should reconnect through the production read-stream recovery path.
        if (!control) return;
        const subscribers = [...control.subscribers].filter(s => !s.destroyed);
        const identities = new Set(subscribers.map(s => s.diagnosticSession));
        if(priorSubscriptions && [...identities].some(id => !priorSubscriptions.has(id)))
          observedReconnections++;
        if(subscribers.length) {
          priorSubscriptions = identities;
          for (const socket of subscribers) socket.destroy();
          cycles++;
        }
        fs.writeFileSync(
          path.join(directory, 'performance-soak.json'),
          JSON.stringify({
            reconnectCycles: cycles,
            observedReconnections,
            ownershipLeasePreserved: !!originalOwner && control.owner === originalOwner && !originalOwner.destroyed,
            subscribersBeforeLastDisconnect: subscribers.length,
            boundedLatestFrames: [...control.subscribers].every(
              (s) => !s.latestState || Buffer.byteLength(s.latestState) <= 2 * 1024 * 1024,
            ),
            clients: control.clients.size,
            subscribers: control.subscribers.size,
          }),
        );
      }, 15000);
    }
    if (command.phase === 'image_decode')
      overlay = {
        assistant: {
          responding: false,
          error: '',
          messages: [
            {
              id: 'synthetic-large-image',
              text: '',
              answer: 'Synthetic image decode',
              status: 'complete',
              images: [
                {
                  id: 'synthetic-image',
                  path: path.join(directory, 'large-preview.png'),
                  name: 'Synthetic image',
                },
              ],
            },
          ],
        },
      };
    if (command.phase === 'stop') overlay = {};
    queue.setFeed({ ...queue.feed, collectedAt: Date.now() / 1000 }, { ok: true, synthetic: true });
    fs.writeFileSync(
      path.join(directory, 'performance-result.json'),
      JSON.stringify({ id: command.id, phase: command.phase, synthetic: true }),
    );
  });
  return observer;
};
const start = NativeControl.prototype.start;
const broadcast = NativeControl.prototype.broadcast;
NativeControl.prototype.broadcast = function (state) {
  return broadcast.call(this, { ...state, ...overlay });
};
NativeControl.prototype.start = async function () {
  control = this;
  const state = this.state;
  this.state = () => ({ ...state(), ...overlay });
  return start.call(this);
};
