'use strict';
const { Commitments } = require('../../src/commitments.cjs');
function fixture() {
  const f = require('./authorization-profile.cjs').fixture();
  let store = new Commitments({ directory: f.directory, humanActorId: f.policy.actorId }),
    reads = 0;
  f.assistant.options.commitments = store;
  f.assistant.options.loadContext = async () => {
    reads++;
    return f.snapshot();
  };
  const questions = [],
    original = f.assistant.provider.answer.bind(f.assistant.provider);
  f.assistant.provider.answer = async (input) => {
    questions.push(input);
    return original(input);
  };
  const close = f.close;
  return {
    ...f,
    get calls() {
      return f.calls;
    },
    get store() {
      return store;
    },
    get reads() {
      return reads;
    },
    questions,
    restartLedger() {
      store.close();
      store = new Commitments(store.options);
      f.assistant.options.commitments = store;
    },
    close() {
      store.close();
      close();
    },
  };
}
module.exports = { fixture };
