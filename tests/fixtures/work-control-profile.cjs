'use strict';
const { WorkControls } = require('../../src/work-controls.cjs');
function fixture() {
  const f = require('./delegation-profile.cjs').fixture();
  f.client.active = new Map();
  f.client.loaded = new Set();
  let interrupts = 0,
    research = null;
  f.client.prepare = async (id) => {
    f.client.loaded.add(id);
  };
  const send = f.client.send;
  f.client.send = async (...args) => {
    const result = await send(...args);
    f.client.active.set(args[0], result.turn.id);
    return result;
  };
  f.client.stop = async (sourceId, turnId) => {
    if (f.client.active.get(sourceId) !== turnId || !f.client.loaded.has(sourceId))
      throw Object.assign(new Error('Unowned fixture turn'), { delivery: 'not-sent' });
    interrupts++;
    await f.client.onInterrupt?.({ sourceId, turnId });
    return { sourceId, turnId, delivery: 'interrupt_requested' };
  };
  let controls = new WorkControls({
    directory: f.directory,
    policy: f.policy,
    messages: f.messages,
    responsibilities: f.responsibilities,
    schedules: f.schedules,
    delegations: f.delegations,
    snapshot: f.snapshot,
    research: () => research,
    interrupt: (input) => f.controller.stopSource(input),
  });
  const admission = f.messages.admission,
    authorize = f.messages.authorize,
    probe = f.schedules.options.probe;
  f.messages.admission = (entry) => {
    const work = controls.messageAdmission(entry);
    return work === 'allow' ? admission(entry) : work;
  };
  f.messages.authorize = (input) => {
    const work = controls.messageAdmission(input);
    return work === 'allow'
      ? authorize(input)
      : { decision: work === 'wait' ? 'ask' : 'deny', reason: 'work_control_hold' };
  };
  f.responsibilities.options.admission = (entry) => controls.responsibilityAdmission(entry);
  f.delegations.options.workAdmission = (entry) => controls.responsibilityAdmission(entry);
  f.schedules.options.probe = (entry) =>
    controls.scheduleAdmission(entry) === 'allow'
      ? probe(entry)
      : { eligible: false, reason: 'work_control_hold' };
  f.assistant.options.workControls = controls;
  return {
    ...f,
    get calls() {
      return f.calls;
    },
    get questions() {
      return f.questions;
    },
    get interrupts() {
      return interrupts;
    },
    get controls() {
      return controls;
    },
    setResearch(value) {
      research = value;
    },
    restartControls() {
      controls.close();
      controls = new WorkControls(controls.options);
      f.assistant.options.workControls = controls;
    },
    observe() {
      f.observe();
      controls.reconcile();
    },
    close() {
      controls.close();
      f.close();
    },
  };
}
module.exports = { fixture };
