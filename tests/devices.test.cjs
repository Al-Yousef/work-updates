'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { EventEmitter } = require('node:events');
const { Devices, prefix } = require('../src/devices.cjs');
const localId = '11111111-1111-4111-8111-111111111111';
const code = (port) =>
  'wu1:' +
  Buffer.from(
    JSON.stringify({ host: '127.0.0.1', port, pin: 'a'.repeat(64), token: 'b'.repeat(64) }),
  ).toString('base64url');
function state(name, status = 'ready') {
  return {
    cards: [
      {
        id: 'same-card',
        taskKey: 'same-task',
        title: name,
        status,
        at: 1,
        readyForReview: status === 'ready',
        sources: [{ id: 'same-chat', body: name }],
        primarySourceId: 'same-chat',
      },
    ],
    done: [],
    approvals: [{ id: 'same-request', taskId: 'same-card' }],
    groups: [],
    settings: { projects: ['sample-project'] },
    monitoredCount: 1,
    health: { ok: true },
    undo: false,
    host: {
      id:
        name === 'Mac'
          ? '22222222-2222-4222-8222-222222222222'
          : '33333333-3333-4333-8333-333333333333',
      name,
      kind: name === 'Mac' ? 'mac' : 'pc',
    },
  };
}
function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-devices-'));
  const calls = [],
    peers = [],
    local = state('Local');
  const devices = new Devices({
    directory,
    identity: { id: localId, name: 'This PC', kind: 'pc' },
    state: () => local,
    command: async (method, input) => {
      calls.push({ method, input });
      return { id: 'new-local' };
    },
    encrypt: (s) => Buffer.from(s),
    decrypt: (b) => b.toString(),
    makePeer: () => {
      const peer = new EventEmitter();
      peer.connected = false;
      peer.value = state(peers.length ? 'Other PC' : 'Mac');
      peer.calls = [];
      peer.connect = async () => {
        peer.connected = true;
        peer.emit('state', peer.value);
        peer.emit('connection', true);
      };
      peer.command = async (method, input) => {
        peer.calls.push({ method, input });
        return { id: 'new-remote' };
      };
      peer.close = () => {
        peer.connected = false;
      };
      peer.reconnect = () => {};
      peers.push(peer);
      return peer;
    },
  });
  t.after(() => {
    devices.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { devices, calls, peers, local };
}
test('a paired computer adds its queue without hiding local chats or forwarding a merged state', async (t) => {
  const { devices } = setup(t);
  await devices.add(code(12001));
  const snapshot = devices.snapshot();
  assert.equal(snapshot.cards.length, 2);
  assert.equal(snapshot.devices.length, 2);
  assert.equal(snapshot.monitoredCount, 2);
  assert.equal(snapshot.cards.find((c) => c.owner.local).id, 'same-card');
  assert.equal(devices.localState().cards.length, 1);
  assert.equal(devices.localState().host.id, localId);
  assert.equal(devices.localState().protocolVersion, 3);
});
test('identical task, chat and approval IDs on three computers remain separate and route to their owner', async (t) => {
  const { devices, calls, peers } = setup(t);
  const mac = await devices.add(code(12001)),
    pc = await devices.add(code(12002));
  const snapshot = devices.snapshot();
  assert.equal(new Set(snapshot.cards.map((c) => c.id)).size, 3);
  const card = snapshot.cards.find((c) => c.owner.id === mac.id);
  assert.equal(card.sources[0].id, prefix(mac.id) + 'same-chat');
  await devices.command('send', {
    id: card.id,
    taskKey: card.taskKey,
    sourceId: card.sources[0].id,
    text: 'Sample reply',
  });
  assert.deepEqual(peers[0].calls[0], {
    method: 'send',
    input: { id: 'same-card', taskKey: 'same-task', sourceId: 'same-chat', text: 'Sample reply' },
  });
  await devices.command('respond', { id: prefix(pc.id) + 'same-request', decision: 'decline' });
  assert.equal(peers[1].calls[0].input.id, 'same-request');
  assert.equal(calls.length, 0);
  assert.equal(snapshot.approvals.length, 3);
});
test('mixed-device identities and groups are rejected instead of falling back to a different queue', async (t) => {
  const { devices, calls, peers } = setup(t);
  const mac = await devices.add(code(12001));
  await assert.rejects(
    devices.command('send', {
      id: 'same-card',
      sourceId: prefix(mac.id) + 'same-chat',
      text: 'Sample',
    }),
    /another computer/,
  );
  await assert.rejects(
    devices.command('send', {
      id: prefix(mac.id) + 'same-card',
      sourceId: 'same-chat',
      text: 'Sample',
    }),
    /another computer/,
  );
  await assert.rejects(
    devices.command('group', { title: 'Mixed', ids: ['same-chat', prefix(mac.id) + 'same-chat'] }),
    /same computer/,
  );
  assert.equal(calls.length, 0);
  assert.equal(peers[0].calls.length, 0);
});
test('an offline computer keeps labeled last-known context but cannot receive a mutation', async (t) => {
  const { devices, calls, peers } = setup(t);
  const mac = await devices.add(code(12001));
  peers[0].connected = false;
  peers[0].emit('connection', false);
  const card = devices.snapshot().cards.find((c) => c.owner.id === mac.id);
  assert.equal(card.owner.online, false);
  assert.equal(card.sources[0].body, 'Mac');
  assert.equal((await devices.command('details', { id: card.id })).owner.online, false);
  await assert.rejects(devices.command('action', { id: card.id, action: 'reviewed' }), /offline/);
  assert.equal(peers[0].calls.length, 0);
  assert.equal(calls.length, 0);
  devices.remove(mac.id);
  await assert.rejects(
    devices.command('send', { id: card.id, text: 'Sample' }),
    /no longer paired/,
  );
  assert.equal(devices.snapshot().cards.length, 1);
});
test('new tasks explicitly choose their computer and command responses retain viewer identities', async (t) => {
  const { devices, calls, peers } = setup(t);
  const mac = await devices.add(code(12001));
  const remote = await devices.command('create', {
    ownerId: mac.id,
    title: 'Sample',
    prompt: 'Sample prompt',
  });
  assert.equal(remote.id, prefix(mac.id) + 'new-remote');
  assert.equal(peers[0].calls[0].input.ownerId, undefined);
  const local = await devices.command('create', {
    ownerId: localId,
    title: 'Local',
    prompt: 'Sample prompt',
  });
  assert.equal(local.id, 'new-local');
  assert.equal(calls.length, 1);
});
test('review and undo return to the same computer and refresh runs each observer once', async (t) => {
  const { devices, calls, peers } = setup(t);
  const mac = await devices.add(code(12001));
  peers[0].command = async (method, input) => {
    peers[0].calls.push({ method, input });
    return state('Mac');
  };
  await devices.command('action', { id: prefix(mac.id) + 'same-card', action: 'reviewed' });
  await devices.command('undo');
  assert.deepEqual(
    peers[0].calls.map((c) => c.method),
    ['action', 'undo'],
  );
  await devices.command('refresh');
  assert.equal(calls.at(-1).method, 'refresh');
  assert.equal(peers[0].calls.at(-1).method, 'refresh');
});
test('pairing persists protected codes, rejects its own identity and does not store queue contents', async (t) => {
  const { devices, peers } = setup(t);
  await devices.add(code(12001));
  const saved = fs.readFileSync(devices.file, 'utf8');
  assert.ok(!saved.includes('same-chat'));
  assert.ok(!saved.includes('same-card'));
  const oldSize = devices.peers.size;
  peers[0].value.host.id = localId;
  devices.options.makePeer = () => {
    const p = new EventEmitter();
    p.connect = async () => {
      p.connected = true;
      p.emit('state', peers[0].value);
    };
    p.close = () => {
      p.connected = false;
    };
    return p;
  };
  await assert.rejects(devices.add(code(12002)), /own pairing code/);
  assert.equal(devices.peers.size, oldSize);
});

test('forgetting a computer during restore cannot reconnect or persist a late pairing', async (t) => {
  const { devices, peers } = setup(t);
  let release;
  const makePeer = devices.options.makePeer;
  devices.options.makePeer = () => {
    const peer = makePeer();
    peer.connect = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    peer.reconnect = () => {
      assert.fail('A removed pairing must never reconnect');
    };
    return peer;
  };
  const adding = devices.add(code(12001), { restore: true });
  devices.remove([...devices.peers.keys()][0]);
  peers[0].emit('state', state('Mac'));
  release();
  await assert.rejects(adding, /removed/);
  assert.equal(devices.snapshot().cards.length, 1);
  assert.equal(fs.existsSync(devices.file), false);
});

test('a delayed HTTP snapshot cannot undo a newer Reviewed event or restore old chat text', async (t) => {
  const { devices, peers } = setup(t);
  const mac = await devices.add(code(12001));
  const old = state('Mac');
  old.servedAt = 100;
  old.stateVersion = { epoch: '44444444-4444-4444-8444-444444444444', revision: 1 };
  old.cards[0].reviewed = false;
  peers[0].emit('state', old);
  let release;
  peers[0].command = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const command = devices.command('action', {
    id: prefix(mac.id) + 'same-card',
    action: 'reviewed',
  });
  const latest = structuredClone(old);
  latest.stateVersion.revision = 2;
  latest.cards[0].reviewed = true;
  latest.cards[0].sources[0].body = 'Latest reply';
  peers[0].emit('state', latest);
  release(old);
  await command;
  const card = devices.snapshot().cards.find((c) => c.owner.id === mac.id);
  assert.equal(card.reviewed, true);
  assert.equal(card.sources[0].body, 'Latest reply');
});

test('an acknowledged action after forgetting its computer cannot resurrect undo ownership', async (t) => {
  const { devices, peers } = setup(t);
  const mac = await devices.add(code(12001));
  let release;
  peers[0].command = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const command = devices.command('action', {
    id: prefix(mac.id) + 'same-card',
    action: 'reviewed',
  });
  devices.remove(mac.id);
  release(state('Mac'));
  await command;
  assert.equal(devices.lastUndo, null);
  assert.equal(devices.snapshot().cards.length, 1);
});

test('a command from a replaced connection cannot overwrite its new host snapshot or undo owner', async (t) => {
  const { devices, peers } = setup(t);
  const mac = await devices.add(code(12001));
  peers[0].generation = 1;
  let release;
  peers[0].command = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const command = devices.command('action', {
    id: prefix(mac.id) + 'same-card',
    action: 'reviewed',
  });
  peers[0].generation = 2;
  const latest = state('Mac');
  latest.cards[0].sources[0].body = 'After restart';
  peers[0].emit('state', latest);
  release(state('Mac'));
  await command;
  assert.equal(devices.lastUndo, null);
  assert.equal(
    devices.snapshot().cards.find((c) => c.owner.id === mac.id).sources[0].body,
    'After restart',
  );
});

test('forget all and re-pair the same host cannot inherit an earlier pairing command or Undo', async (t) => {
  const { devices, peers } = setup(t);
  const old = await devices.add(code(12001));
  await devices.command('action', { id: prefix(old.id) + 'same-card', action: 'reviewed' });
  let release;
  peers[0].command = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = devices.command('action', {
    id: prefix(old.id) + 'same-card',
    action: 'reviewed',
  });
  devices.remove();
  assert.equal(devices.lastUndo, null);
  const makePeer = devices.options.makePeer;
  devices.options.makePeer = () => {
    const peer = makePeer();
    peer.value = state('Mac');
    peer.value.cards[0].sources[0].body = 'New pairing';
    return peer;
  };
  const fresh = await devices.add(code(12001));
  assert.notEqual(fresh.id, old.id);
  release(state('Mac'));
  await pending;
  assert.equal(devices.lastUndo, null);
  assert.equal(devices.snapshot().cards.find((c) => !c.owner.local).sources[0].body, 'New pairing');
  assert.equal(peers[1].calls.length, 0);
});

test('a host epoch change while a command completes reconnects without restoring Undo', async (t) => {
  const { devices, peers } = setup(t);
  const mac = await devices.add(code(12001));
  peers[0].generation = 1;
  const old = state('Mac');
  old.stateVersion = { epoch: '44444444-4444-4444-8444-444444444444', revision: 80 };
  peers[0].emit('state', old);
  let resyncs = 0;
  peers[0].resync = () => {
    resyncs++;
    peers[0].generation++;
    peers[0].connected = false;
  };
  const restart = state('Mac');
  restart.stateVersion = { epoch: '55555555-5555-4555-8555-555555555555', revision: 1 };
  restart.cards[0].sources[0].body = 'Restarted host';
  peers[0].command = async () => restart;
  await devices.command('action', { id: prefix(mac.id) + 'same-card', action: 'reviewed' });
  assert.equal(resyncs, 1);
  assert.equal(devices.lastUndo, null);
  assert.equal(devices.snapshot().cards.find((c) => !c.owner.local).sources[0].body, 'Mac');
  peers[0].connected = true;
  peers[0].emit('state', restart);
  assert.equal(
    devices.snapshot().cards.find((c) => !c.owner.local).sources[0].body,
    'Restarted host',
  );
});
