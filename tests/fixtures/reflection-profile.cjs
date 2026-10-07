'use strict';
const { Reflections } = require('../../src/reflections.cjs'),
  { Commitments } = require('../../src/commitments.cjs');
function fixture() {
  const f = require('./research-profile.cjs').fixture(),
    commitments = new Commitments({ directory: f.directory, humanActorId: f.policy.actorId });
  let reflections = new Reflections({
    directory: f.directory,
    policy: f.policy,
    research: f.research,
    commitments,
    now: () => f.now,
  });
  f.assistant.options.commitments = commitments;
  f.assistant.options.reflections = reflections;
  const config = (overrides) => ({
    timeZone: 'America/Toronto',
    cadence: 'manual',
    wallTime: null,
    weekdays: [],
    until: new Date(f.now + 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    maxReviews: 16,
    retentionDays: 1,
    recordLimit: 8,
    characterBudget: 8000,
    commitmentLimit: 8,
    ...overrides,
  });
  let researchId;
  async function enable(overrides) {
    if (!researchId) {
      const result = await f.enable();
      researchId = result.researchId;
      if (!researchId) throw new Error(result.answer);
    }
    return f.ask('/reflection enable ' + researchId + ': ' + JSON.stringify(config(overrides)));
  }
  return {
    ...f,
    get reads() {
      return f.reads;
    },
    get now() {
      return f.now;
    },
    get research() {
      return f.research;
    },
    get calls() {
      return f.calls;
    },
    get questions() {
      return f.questions;
    },
    get reflections() {
      return reflections;
    },
    commitments,
    config,
    enableReflection: enable,
    get researchId() {
      return researchId;
    },
    restartReflection() {
      reflections.close();
      reflections = new Reflections({ ...reflections.options, research: f.research });
      f.assistant.options.reflections = reflections;
    },
    close() {
      reflections.close();
      commitments.close();
      f.close();
    },
  };
}
module.exports = { fixture };
