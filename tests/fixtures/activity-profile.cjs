'use strict';
const { Activity } = require('../../src/activity.cjs');
function fixture() {
  const f = require('./triage-profile.cjs').fixture(),
    stores = {
      policy: f.policy,
      responsibilities: f.responsibilities,
      schedules: f.schedules,
      research: f.research,
      triage: f.triage,
      messages: f.messages,
    };
  let activity;
  const options = {
    directory: f.directory,
    snapshot: f.snapshot,
    actorId: () => f.policy.actorId,
    now: () => f.now,
    synthetic: true,
  };
  const rawReader = f.research.options.reader,
    rawDispatch = f.responsibilities.options.dispatch;
  const connect = () => {
    activity = new Activity(options);
    activity.attach(stores);
    f.research.options.reader = activity.reader(rawReader, f.research);
    f.responsibilities.options.dispatch = activity.dispatch(rawDispatch, f.responsibilities);
    f.assistant.options.activity = activity;
  };
  connect();
  return {
    ...f,
    get activity() {
      return activity;
    },
    get triage() {
      return f.triage;
    },
    get now() {
      return f.now;
    },
    get reads() {
      return f.reads;
    },
    get calls() {
      return f.calls;
    },
    stores,
    restart() {
      f.restart();
      stores.triage = f.triage;
      activity.attach(stores);
    },
    restartActivity() {
      activity.close();
      connect();
    },
    close() {
      activity.close();
      f.close();
    },
  };
}
module.exports = { fixture };
