'use strict';
const { Delegations } = require('../../src/delegations.cjs'),
  { currentScope } = require('../../src/responsibility-target.cjs');
function fixture() {
  const f = require('./authorization-profile.cjs').fixture();
  let clock = Date.now(),
    delegations = new Delegations({
      directory: f.directory,
      policy: f.policy,
      messages: f.messages,
      responsibilities: f.responsibilities,
      snapshot: f.snapshot,
      now: () => clock,
    });
  const oldAuthorize = f.responsibilities.options.authorize,
    oldAdmission = f.messages.admission,
    oldCreate = f.messages.authorize;
  f.responsibilities.options.authorize = (entry) =>
    delegations.authorize(entry) || oldAuthorize(entry);
  f.messages.admission = (entry) => {
    const allowed = delegations.admission(entry);
    return allowed === 'allow' ? oldAdmission(entry) : allowed;
  };
  f.messages.authorize = (input) => {
    const allowed = delegations.admission(input, { creating: true });
    return allowed === 'allow'
      ? oldCreate(input)
      : { decision: allowed === 'wait' ? 'ask' : 'deny', reason: 'delegation_gate' };
  };
  f.assistant.options.delegations = delegations;
  f.source.lifecycle = 'working';
  const fs = require('node:fs'),
    path = require('node:path');
  f.source.cwd = path.join(f.directory, 'parent-workspace');
  fs.mkdirSync(f.source.cwd);
  const sources = f.queue.feed.threads.filter((s) => s.id !== f.source.id);
  for (const [i, s] of sources.entries()) {
    s.lifecycle = 'working';
    s.cwd = path.join(f.directory, 'child-workspace-' + i);
    fs.mkdirSync(s.cwd);
  }
  let parentId;
  async function parent() {
    if (!parentId) {
      const started = await f.ask(
        '/responsibility start Coordinate the synthetic results and require human review of the requested goal.',
      );
      if (started.status !== 'completed') throw new Error(started.answer);
      parentId = started.responsibilityId;
    }
    return parentId;
  }
  const scope = (source) =>
    currentScope({ sourceId: source.id, ownerId: f.scope.ownerId }, f.snapshot());
  async function start(
    instruction = 'Review the first synthetic result',
    source = sources[0],
    seconds = 600,
  ) {
    return f.ask(
      '/delegation start ' +
        (await parent()) +
        ' ' +
        source.id +
        ' ' +
        seconds +
        ': ' +
        instruction,
    );
  }
  function observe() {
    f.observe();
    delegations.observe();
  }
  function complete(id, status = 'completed') {
    observe();
    const e = delegations.entry(id),
      step = delegations.child(e).currentStep,
      source = f.queue.feed.threads.find((s) => s.id === e.scope.sourceId);
    source.lifecycle = status === 'completed' ? 'completed' : 'failed';
    source.turnId = step.turnId;
    source.turnOutcome = status;
    f.client.emit('notification', {
      method: 'turn/completed',
      params: { threadId: source.id, turn: { id: step.turnId, status } },
    });
    observe();
  }
  const close = f.close;
  return {
    ...f,
    get calls() {
      return f.calls;
    },
    get questions() {
      return f.questions;
    },
    get delegations() {
      return delegations;
    },
    sources,
    scope,
    parent,
    start,
    observe,
    complete,
    advance: (ms) => (clock += ms),
    restart() {
      delegations.close();
      delegations = new Delegations(delegations.options);
      f.assistant.options.delegations = delegations;
    },
    close() {
      delegations.close();
      close();
    },
  };
}
module.exports = { fixture };
