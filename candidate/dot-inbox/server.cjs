'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Queue } = require('../../src/queue.cjs');
const { statusLabel } = require('../../src/attention.cjs');
const { StatePublisher } = require('../../src/state-order.cjs');
const { InboxFixture, contextRevision } = require('./fixture.cjs');
const { identity, uniqueCards } = require('./model.js');
const { ActionJournal } = require('./journal.cjs');
const { startReadOnlyObserver, sourceIdentity } = require('../../src/read-only-observer.cjs');
const root = path.resolve(__dirname, '../..');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};
async function startPreview({
  liveRoot = null,
  port = 0,
  recoveryRoot = null,
  sessionsRoot = null,
  protocolFixtures = false,
  collectLocal = null,
  privacyReview = false,
  collectorOptions = {},
} = {}) {
  if (collectLocal && !liveRoot)
    throw new Error('Read-only collection requires a queue state root.');
  const artifacts = sessionsRoot || path.join(root, 'artifacts', 'dot-inbox');
  fs.mkdirSync(artifacts, { recursive: true });
  const directory = fs.mkdtempSync(path.join(artifacts, 'session-'));
  const journal = new ActionJournal(recoveryRoot || path.join(directory, 'recovery'));
  let fixture, flowCheckpoint;
  const checkpoint = (flow = flowCheckpoint) => {
    flowCheckpoint = flow;
    if (!fixture) return;
    journal.value.fixture = structuredClone({
      ...fixture.export(),
      flow: flow || fixture.session.flow.export(),
    });
    journal.save();
  };
  fixture = protocolFixtures
    ? await require('./protocol-fixture.cjs').ProtocolFixture.create(directory, {
        restored: journal.value.fixture,
        checkpoint,
        protocolRoot: path.join(path.dirname(journal.file), 'protocol-peers'),
      })
    : new InboxFixture(directory, { restored: journal.value.fixture, checkpoint });
  if (protocolFixtures) checkpoint();
  const publisher = new StatePublisher();
  const liveQueue = new Queue(path.join(directory, 'live-copy'));
  const collector = collectLocal
    ? startReadOnlyObserver({ ...collectorOptions, codexHome: collectLocal })
    : null;
  const sourceId = collector?.sourceId || (liveRoot ? sourceIdentity(liveRoot) : '');
  const requests = new Map();
  const uncertain = new Map();
  let origin,
    scenario = journal.value.scenario || 'quiet',
    liveCount = 0,
    liveError = '',
    lastSnapshot;
  let storageFailure = false,
    dropReceipt = false,
    delayReceipt = false;
  function live() {
    if (!liveRoot) return [];
    try {
      // Read the existing files only; never construct a Queue in the installed directory.
      const state = JSON.parse(fs.readFileSync(path.join(liveRoot, 'state.json'), 'utf8'));
      const feed =
        collector?.feed ||
        JSON.parse(fs.readFileSync(path.join(liveRoot, 'observer', 'data', 'feed.json'), 'utf8'));
      const health = collector
        ? collector.health()
        : JSON.parse(
            fs.readFileSync(path.join(liveRoot, 'observer', 'data', 'health.json'), 'utf8'),
          );
      liveQueue.state = structuredClone(state);
      liveQueue.feed = structuredClone(feed);
      liveQueue.health = structuredClone(health);
      const snapshot = liveQueue.snapshot();
      const age = Date.now() / 1000 - Number(feed.collectedAt || 0);
      const healthAge = Date.now() / 1000 - Number(health.at || 0);
      const fresh = collector
        ? health.ok
        : age >= -5 && age < 30 && healthAge >= -5 && healthAge < 30;
      const kind = feed.device?.kind || 'unknown';
      const owner = {
        id: 'local:' + sourceId,
        name: kind === 'mac' ? 'This Mac' : kind === 'pc' ? 'This PC' : 'Local computer',
        kind,
        online: health.ok === true && fresh,
        local: true,
      };
      const recent = snapshot.cards.filter(
        (card) => card.kind === 'local' || card.at >= (snapshot.settings.queueSince || 0),
      );
      const cards = [...recent, ...snapshot.done].map((card) => {
        const prefix = 'live:' + sourceId + ':';
        const value = {
          ...card,
          id: prefix + card.id,
          taskKey: prefix + card.taskKey,
          primarySourceId: card.primarySourceId ? prefix + card.primarySourceId : undefined,
          sources: card.sources.map((s) => ({ ...s, id: prefix + s.id })),
          owner,
          provenance: {
            mode: 'read-only',
            channel: 'Local Codex · read only',
            project: card.groupName || 'Local Codex',
            sender: card.chatName,
          },
        };
        value.contextRevision = contextRevision(value);
        if (!privacyReview) return value;
        // Presentation is redacted before entering the browser. The real source
        // binding and context revision stay intact, and no incoming text is saved.
        const sampleName =
          'Private chat ' + crypto.createHash('sha256').update(value.id).digest('hex').slice(0, 4);
        const waitingOn = { kind: value.waitingOn?.kind || 'unknown', name: '' };
        return {
          id: value.id,
          taskKey: value.taskKey,
          primarySourceId: value.primarySourceId,
          title: 'Task text withheld',
          chatName: sampleName,
          groupName: '',
          summary: 'Private text withheld. Status comes from the local recorded chat.',
          device: value.device,
          kind: value.kind,
          status: value.status,
          waitingOn,
          urgent: value.urgent,
          label: statusLabel(value.status, waitingOn),
          at: value.at,
          reviewed: value.reviewed,
          snoozed: value.snoozed,
          done: value.done,
          readyForReview: value.readyForReview,
          contextRevision: value.contextRevision,
          sources: value.sources.map((s) => ({
            id: s.id,
            title: sampleName,
            taskTitle: 'Task text withheld',
            summary: 'Private text withheld.',
            body: 'Private conversation text is withheld in this review.',
            device: s.device,
            contextLoaded: s.contextLoaded,
            lifecycle: s.lifecycle,
          })),
          owner,
          provenance: {
            mode: 'read-only',
            sender: sampleName,
            project: 'Local Codex',
            channel: 'Local Codex · text withheld',
          },
        };
      });
      const unique = uniqueCards(cards);
      liveCount = unique.length;
      liveError =
        fresh && health.ok
          ? ''
          : health.message || 'Local Codex context is cached; its watcher is not current.';
      return unique;
    } catch {
      liveError = 'Local Codex snapshot unavailable. No production actions are connected.';
      liveCount = 0;
      return [];
    }
  }
  function snapshot() {
    const state = fixture.snapshot();
    state.cards.forEach((c) => {
      c.replyUncertain = c.sources
        .filter(
          (s) =>
            uncertain.has(identity(c, s.id)) ||
            journal.value.events.some(
              (e) =>
                e.action === 'reply' &&
                ['inFlight', 'uncertain'].includes(e.state) &&
                e.ownerId === c.owner.id &&
                e.id === c.id &&
                e.taskKey === c.taskKey &&
                e.sourceId === s.id,
            ),
        )
        .map((s) => s.id);
    });
    const liveCards = live();
    const deliveries = [...fixture.session.flow.outbox.values()].map((i) => ({
      id: i.id,
      kind: i.kind,
      state: i.state,
      computers: i.refs.map((r) => r.computer),
      tasks: i.refs.map((r) => r.task),
    }));
    lastSnapshot = publisher.stamp({
      ...state,
      cards: [...state.cards, ...liveCards],
      scenario,
      deliveries,
      preview: {
        liveEnabled: !!liveRoot,
        liveCount,
        liveError,
        readOnly: true,
        commands: fixture.commands.slice(-15),
        simulatedTime: fixture.time,
        actionEvents: journal.publicEvents(),
        storageFailure,
        journalError: journal.error,
        deliveryBoundary: 'Synthetic transport only. Owner-app acceptance is a separate result.',
        protocolFixture: protocolFixtures,
        privacyReview,
        collector: collector
          ? {
              ...collector.health(),
              pid: collector.pid,
              monitoredCount: collector.feed?.monitoredCount || 0,
              warnings: collector.feed?.warnings || [],
            }
          : null,
      },
    });
    return lastSnapshot;
  }
  function bound(input) {
    const state = snapshot();
    const item = state.cards.find(
      (c) => c.id === input.id && c.taskKey === input.taskKey && c.owner.id === input.ownerId,
    );
    if (
      !item ||
      !item.sources.some((s) => s.id === input.sourceId) ||
      item.contextRevision !== input.contextRevision
    )
      throw new Error('This task or source changed. Reopen its latest update.');
    if (item.provenance.mode !== 'synthetic')
      throw new Error('Live Codex actions are disabled in this preview.');
    if (!item.owner.online)
      throw new Error('The selected computer is offline. Your draft is saved.');
    if (item.done) throw new Error('This task is already complete.');
    return item;
  }
  async function act(input) {
    if (typeof input.eventId !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.eventId))
      throw new Error('A unique fixture event ID is required.');
    const saved = journal.existing(input);
    if (saved) return saved;
    const item = bound(input);
    const key = identity(item, input.sourceId);
    if (input.action === 'reply' && uncertain.has(key))
      throw new Error(
        'The previous reply may have arrived. Inspect the sample context; no retry is enabled.',
      );
    if (input.action === 'reply' && item.replyUncertain.includes(input.sourceId))
      throw new Error('The previous reply is pending or uncertain. No retry is enabled.');
    if (
      input.action === 'reply' &&
      journal.value.events.some(
        (e) =>
          e.ownerAccepted &&
          e.action === 'reply' &&
          e.signature === require('./journal.cjs').signature(input),
      )
    )
      throw new Error('This exact reply was already accepted. It will not be sent twice.');
    if (
      !['reviewed', 'snooze', 'reply', ...(protocolFixtures ? ['done'] : [])].includes(input.action)
    )
      throw new Error('Unknown fixture action.');
    if (
      input.action === 'reply' &&
      (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 12000)
    )
      throw new Error('Add a reply of at most 12000 characters.');
    // Save before awaiting to prevent concurrent duplicate event IDs from dispatching twice.
    const pending = {
      state: 'inFlight',
      ownerAccepted: false,
      providerAccepted: true,
      reason: 'Local fixture received this event; waiting for the selected owner.',
    };
    const record = journal.begin(input);
    requests.set(input.eventId, pending);
    let result;
    try {
      const dispatch = async () => {
        const row = [...fixture.session.flow.rows.values()].find(
          (r) =>
            r.ref.cardId === item.id &&
            r.ref.taskKey === item.taskKey &&
            r.ref.ownerId === item.owner.id,
        );
        const delivery = row && fixture.session.flow.outbox.get(row.messageId);
        if (
          input.action !== 'done' &&
          delivery &&
          !uncertain.has(key) &&
          !item.replyUncertain.includes(input.sourceId) &&
          ['accepted', 'delivered'].includes(delivery.state) &&
          (input.action !== 'reply' || input.sourceId === row.ref.sourceId)
        ) {
          const receipt = await fixture.session.flow.receive({
            channel: 'synthetic',
            senderId: 'preview-owner',
            eventId: input.eventId,
            notificationId: delivery.id,
            ownerId: item.owner.id,
            taskKey: item.taskKey,
            action: input.action,
            text: input.text,
          });
          result = {
            state: receipt.state,
            ownerAccepted: receipt.codexAccepted,
            providerAccepted: true,
            reason: receipt.reason || '',
          };
        } else {
          await fixture.devices.command(input.action === 'reply' ? 'send' : 'action', {
            ownerId: item.owner.id,
            id: item.id,
            taskKey: item.taskKey,
            sourceId: input.sourceId,
            ...(input.action === 'reply' ? { text: input.text.trim() } : { action: input.action }),
          });
          fixture.session.observe();
          result = { state: 'accepted', ownerAccepted: true, providerAccepted: true, reason: '' };
        }
      };
      if (fixture.dispatch) await fixture.dispatch(input, item, dispatch);
      else await dispatch();
    } catch (error) {
      result = {
        state: 'uncertain',
        ownerAccepted: false,
        providerAccepted: true,
        reason: error.message,
      };
    }
    if (result.state === 'uncertain') uncertain.set(key, result);
    checkpoint();
    journal.receipt(record, result);
    requests.set(input.eventId, result);
    return result;
  }
  function choose(value) {
    if (value === 'collector-stop' || value === 'collector-reconnect') {
      if (!collector) throw new Error('No isolated collector is connected.');
      if (value === 'collector-stop') collector.pause();
      else collector.resume();
      return;
    }
    if (
      protocolFixtures &&
      !['storage-error', 'storage-retry', 'receipt-loss', 'late-acceptance'].includes(value)
    ) {
      return (async () => {
        if (value === 'done') {
          const ownerId = fixture.owners[1].identity.pairId;
          const card = fixture
            .snapshot()
            .cards.find((card) => card.owner.id === ownerId && card.kind !== 'local' && !card.done);
          if (card)
            await act({
              ownerId,
              id: card.id,
              taskKey: card.taskKey,
              sourceId: card.primarySourceId,
              contextRevision: card.contextRevision,
              eventId: crypto.randomUUID(),
              action: 'done',
              text: '',
            });
        } else await fixture.choose(value);
        scenario = value;
        journal.value.scenario = scenario;
        checkpoint();
      })();
    }
    if (['quiet', 'active', 'empty', 'loading', 'error', 'long', 'uncertain'].includes(value)) {
      fixture.setup(value);
      scenario = value;
    } else if (value === 'offline') {
      fixture.peer.connected = false;
      fixture.devices.emit('change');
      scenario = value;
    } else if (value === 'reconnect') {
      fixture.error = '';
      fixture.loading = false;
      fixture.peer.connected = true;
      fixture.peer.generation++;
      fixture.publish();
      fixture.deliver();
      scenario = 'active';
    } else if (value === 'changed') {
      fixture.changed();
      scenario = value;
    } else if (value === 'removed') {
      fixture.removed();
      scenario = value;
    } else if (value === 'storage-error') {
      storageFailure = true;
      journal.fail = true;
      return;
    } else if (value === 'storage-retry') {
      storageFailure = false;
      journal.fail = false;
      checkpoint();
      return;
    } else if (value === 'receipt-loss') {
      dropReceipt = true;
      return;
    } else if (value === 'late-acceptance') {
      delayReceipt = true;
      return;
    } else if (value === 'forgotten-owner') {
      fixture.devices.peers.delete(fixture.entry.id);
      fixture.session.observe();
    } else if (value === 'context-changed') {
      fixture.mac.feed.threads[0].body += ' A new source update arrived.';
      fixture.publish();
    } else if (value === 'done') {
      const card = fixture
        .snapshot()
        .cards.find(
          (c) => c.owner.id === fixture.entry.id && c.chatName.startsWith('Mac companion'),
        );
      if (card)
        fixture.execute(
          fixture.mac,
          'action',
          {
            id: card.id.replace(/^peer:[a-f0-9-]{36}:/i, ''),
            taskKey: card.taskKey.replace(/^peer:[a-f0-9-]{36}:/i, ''),
            action: 'done',
          },
          fixture.entry.id,
        );
      fixture.publish();
    } else if (value === 'advance') fixture.advance();
    else if (value === 'duplicate') {
      const old = fixture.entry.state;
      fixture.publish();
      const accepted = fixture.devices.receive(fixture.entry, old);
      fixture.duplicateRejected = !accepted;
    } else throw new Error('Unknown scenario.');
    journal.value.scenario = scenario;
    checkpoint();
  }
  const files = {
    '/': path.join(__dirname, 'index.html'),
    '/index.html': path.join(__dirname, 'index.html'),
    '/app.js': path.join(__dirname, 'app.js'),
    '/model.js': path.join(__dirname, 'model.js'),
    '/style.css': path.join(__dirname, 'style.css'),
    '/base.css': path.join(root, 'ui', 'style.css'),
    '/icon.svg': path.join(root, 'assets', 'icon.svg'),
  };
  const server = http.createServer(async (req, res) => {
    const headers = {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    };
    const json = (code, body) => {
      res.writeHead(code, { ...headers, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.headers.host !== origin?.slice('http://'.length))
        return json(403, { error: 'Unexpected host.' });
      if (req.headers.origin && req.headers.origin !== origin)
        return json(403, { error: 'Foreign origins are disabled.' });
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && url.pathname === '/api/state') return json(200, snapshot());
      if (req.method === 'POST' && ['/api/action', '/api/scenario'].includes(url.pathname)) {
        if (req.headers.origin !== origin || req.headers['x-dot-preview'] !== 'fixture')
          return json(403, { error: 'Only this local preview can act on fixtures.' });
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 20000) throw new Error('Request too large.');
        }
        const input = JSON.parse(body);
        if (url.pathname === '/api/scenario') {
          await choose(input.value);
          return json(200, {
            snapshot: snapshot(),
            duplicateRejected: !!fixture.duplicateRejected,
          });
        }
        const result = await act(input);
        if (dropReceipt) {
          dropReceipt = false;
          res.destroy();
          return;
        }
        if (delayReceipt) {
          delayReceipt = false;
          await new Promise((resolve) => setTimeout(resolve, 8000));
        }
        return json(200, { result, snapshot: snapshot() });
      }
      if (req.method !== 'GET' || !files[url.pathname]) return json(404, { error: 'Not found.' });
      const file = files[url.pathname];
      res.writeHead(200, { ...headers, 'Content-Type': types[path.extname(file)] });
      fs.createReadStream(file).pipe(res);
    } catch (error) {
      json(409, { error: error.message });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      origin = 'http://127.0.0.1:' + server.address().port;
      resolve({
        server,
        origin,
        fixture,
        snapshot,
        act,
        choose,
        journal,
        collector,
        directory,
        close: () =>
          new Promise((done) => {
            fixture.close();
            collector?.close();
            server.close(() => {
              const target = path.resolve(directory),
                allowed = path.resolve(artifacts) + path.sep;
              if (target.startsWith(allowed) && path.basename(target).startsWith('session-'))
                fs.rmSync(target, { recursive: true, force: true });
              done();
            });
          }),
      });
    });
  });
}
module.exports = { startPreview };
