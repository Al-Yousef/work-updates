'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { atomicJSON } = require('./private-store.cjs');
const { conversation } = require('./assistant-context.cjs');
const isControl = (m) => /^\/privacy(?:\s|$)/.test(m.text || '');
function adapters({
  directory,
  assistant,
  sourcePaused,
  sourceDependencies = () => [],
  forgetFeed = () => {},
  retained = {},
}) {
  const ownedJSON = (relative) => {
    const root = fs.realpathSync.native(directory),
      file = path.join(directory, relative);
    let parent = path.dirname(file);
    while (!fs.existsSync(parent)) parent = path.dirname(parent);
    const actual = fs.realpathSync.native(parent),
      relation = path.relative(root, actual);
    if (relation.startsWith('..') || path.isAbsolute(relation))
      throw new Error('Private cache escaped its owned directory.');
    if (!fs.existsSync(file)) return { file, value: null };
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024)
      throw new Error('Private cache requires recovery.');
    return { file, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  };
  const readCache = (sourceId) => {
    if (!sourceId) throw new Error('Choose the exact disconnected source.');
    const cache = ownedJSON('observer/data/source-cache.json'),
      feed = ownedJSON('observer/data/feed.json'),
      details = ownedJSON('observer/data/details-request.json');
    if (cache.value && (typeof cache.value !== 'object' || Array.isArray(cache.value)))
      throw new Error('Invalid private source cache.');
    if (feed.value && !Array.isArray(feed.value.threads))
      throw new Error('Invalid private source feed.');
    if (details.value && !Array.isArray(details.value.threadIds))
      throw new Error('Invalid private details request.');
    return {
      cache: cache.value?.[sourceId] || null,
      feed: feed.value?.threads.filter((t) => t.id === sourceId) || [],
      details: details.value?.threadIds.filter((id) => id === sourceId) || [],
    };
  };
  const assistantChange = (change) => {
    const live = assistant(),
      prior = structuredClone(live.state);
    try {
      change(live.state);
      live.save();
      live.emit('change');
    } catch (error) {
      live.state = prior;
      throw error;
    }
  };
  const otherAnswer = () =>
    assistant().state.messages.some((m) => m.status === 'thinking' && !isControl(m))
      ? ['An assistant answer is still using retained context']
      : [];
  return {
    ...retained,
    notes: {
      read: () => structuredClone(assistant().state.notes),
      dependencies: otherAnswer,
      remove: () =>
        assistantChange((s) => {
          s.notes = [];
        }),
      removed: (value) => Array.isArray(value) && value.length === 0,
    },
    conversation: {
      read: () =>
        structuredClone(assistant().state.messages.filter((m) => conversation(m) && !isControl(m))),
      dependencies: otherAnswer,
      remove: (_, selected) =>
        assistantChange((s) => {
          const ids = new Set(selected.map((m) => m.id));
          s.messages = s.messages.filter((m) => !ids.has(m.id) && m.kind !== 'memory_inspection');
          s.historySelection = [];
        }),
      removed: (value) => Array.isArray(value) && value.length === 0,
    },
    'source-cache': {
      read: readCache,
      dependencies: sourceDependencies,
      removed: (value) =>
        value.cache === null && value.feed.length === 0 && value.details.length === 0,
      remove: async (sourceId, selected) =>
        sourcePaused(async () => {
          if (JSON.stringify(readCache(sourceId)) !== JSON.stringify(selected))
            throw new Error('The selected private source cache changed while stopping its writer.');
          const cache = ownedJSON('observer/data/source-cache.json'),
            feed = ownedJSON('observer/data/feed.json'),
            details = ownedJSON('observer/data/details-request.json');
          if (cache.value) {
            delete cache.value[sourceId];
            atomicJSON(cache.file, cache.value);
          }
          if (feed.value) {
            feed.value.threads = feed.value.threads.filter((t) => t.id !== sourceId);
            atomicJSON(feed.file, feed.value);
          }
          if (details.value) {
            details.value.threadIds = details.value.threadIds.filter((id) => id !== sourceId);
            atomicJSON(details.file, details.value);
          }
          forgetFeed(sourceId);
        }),
    },
  };
}
module.exports = { adapters };
