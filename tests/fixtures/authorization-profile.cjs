'use strict';
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  { EventEmitter } = require('node:events');
const { Queue } = require('../../src/queue.cjs'),
  { Messages } = require('../../src/messages.cjs'),
  { Controller } = require('../../src/controller.cjs'),
  { Authorization } = require('../../src/authorization.cjs'),
  { Responsibilities } = require('../../src/responsibilities.cjs'),
  { Schedules } = require('../../src/schedules.cjs'),
  { Assistant } = require('../../src/assistant.cjs');
const bridge = require('../../src/responsibility-authorization.cjs'),
  target = require('../../src/responsibility-target.cjs'),
  scheduled = require('../../src/scheduled-responsibility.cjs');
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-responsibility-audit-policy-')),
    queue = new Queue(directory),
    client = new EventEmitter();
  queue.setFeed(require('../../src/demo.cjs').feed());
  let policy,
    responsibilities,
    schedules,
    messages,
    clock = Date.now(),
    calls = 0,
    questions = 0;
  const controller = new Controller(queue, client);
  client.prepare = async () => {};
  client.send = async (thread, text, images, options) => {
    require('../../src/dispatch-deadline.cjs').admission(options);
    client.run?.({ thread, text, images, options });
    calls++;
    return { turn: { id: 'policy-turn-' + calls } };
  };
  const snapshot = () => {
    const state = messages.decorate(queue.snapshot());
    state.cards = state.cards.map((c) => ({
      ...c,
      chatName: c.chatName || c.title,
      owner: {
        id: 'fixture-policy-pc',
        name: 'Policy fixture PC',
        kind: 'pc',
        local: true,
        online: true,
      },
    }));
    return state;
  };
  messages = new Messages(queue, controller, {
    auto: false,
    authorize: (input) => bridge.authorizeDispatch(policy, input, snapshot()),
    admission: (message) => {
      const allowed = scheduled.admission(responsibilities, schedules, message);
      return allowed === 'allow'
        ? bridge.messageAdmission(policy, responsibilities, snapshot(), message, schedules)
        : allowed;
    },
  });
  policy = new Authorization({ directory, actorId: 'fixture-human' });
  messages.on('change', () => bridge.observe(policy, messages));
  const dispatch = async (mode, input) => ({
    ...(await (mode === 'cancel'
      ? messages.cancel(input.messageId, input.sourceId)
      : messages.enqueue(input))),
    ownerId: 'fixture-policy-pc',
  });
  responsibilities = new Responsibilities({
    directory,
    snapshot,
    ...target,
    outcome: require('../../src/assistant-coordination.cjs').outcome,
    dispatch,
    cancel: (input) => dispatch('cancel', input),
    authorize: (entry) =>
      bridge.prepare(
        policy,
        entry,
        snapshot(),
        entry.currentStep.schedule ? schedules.entry(entry.currentStep.schedule.id) : null,
      ),
  });
  schedules = new Schedules({
    directory,
    now: () => clock,
    probe: (entry) => scheduled.probe(responsibilities, entry),
    run: (entry) => scheduled.run(responsibilities, entry),
    outcome: (entry, run) => scheduled.outcome(responsibilities, entry, run),
  });
  const assistant = new Assistant({
    directory,
    snapshot,
    responsibilities,
    schedules,
    authorization: policy,
    authorizationRequest: (id) => {
      const entry = messages.state.entries.find((e) => e.id === id && e.status === 'queued');
      return entry ? bridge.dispatchRequest({ ...entry, messageId: id }, snapshot()) : null;
    },
    provider: {
      answer: async () => {
        questions++;
        return { answer: 'Read-only synthetic status.', links: [] };
      },
      close() {},
    },
  });
  const card = snapshot().cards[0],
    source = queue.feed.threads.find((s) => s.id === card.primarySourceId),
    scope = target.currentScope({ sourceId: source.id, ownerId: card.owner.id }, snapshot());
  assistant.focus(card, source.id);
  const human = (text) => ({ role: 'human', messageId: crypto.randomUUID(), text }),
    control = (text) => bridge.human(policy, human(text));
  async function ask(text) {
    const id = crypto.randomUUID();
    assistant.ask({ messageId: id, text });
    await assistant.work;
    return assistant.state.messages.find((m) => m.id === id);
  }
  function observe() {
    responsibilities.observe(snapshot());
    schedules.observe();
    bridge.observe(policy, messages);
  }
  function complete() {
    source.lifecycle = 'completed';
    source.turnId = 'policy-turn-' + calls;
    source.turnOutcome = 'completed';
    client.emit('notification', {
      method: 'turn/completed',
      params: { threadId: source.id, turn: { id: source.turnId, status: 'completed' } },
    });
    observe();
  }
  function close() {
    assistant.close();
    schedules.close();
    responsibilities.close();
    messages.close();
    policy.close();
    const resolved = path.resolve(directory);
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith('hyphen-responsibility-audit-policy-')
    )
      throw new Error('Owned policy cleanup escaped its root');
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  return {
    directory,
    queue,
    client,
    controller,
    messages,
    responsibilities,
    schedules,
    assistant,
    source,
    scope,
    human,
    control,
    ask,
    observe,
    complete,
    snapshot,
    close,
    get policy() {
      return policy;
    },
    get calls() {
      return calls;
    },
    get questions() {
      return questions;
    },
    advance: (ms) => (clock += ms),
    restartPolicy() {
      policy.close();
      policy = new Authorization(policy.options);
      assistant.options.authorization = policy;
    },
    spec() {
      return {
        kind: 'interval',
        timeZone: 'America/Toronto',
        anchorAt: clock + 60000,
        intervalMs: 60000,
        endAt: clock + 3600000,
      };
    },
  };
}
module.exports = { fixture };
