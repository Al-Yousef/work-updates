'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const store = require('./private-store.cjs');
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const imageName = /^[a-f0-9]{64}\.(png|jpg|webp|gif)$/;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Only exact files inside the already owned profile are considered. Unknown
// files and redirected directories are held, never recursively removed.
function retainedAdapters({
  directory,
  assistant,
  research,
  reflections,
  messages,
  attachments,
  voice,
  diagnostics,
}) {
  const root = fs.realpathSync.native(directory);
  function owned(relative) {
    const file = path.join(root, relative);
    let parent = path.dirname(file);
    while (!fs.existsSync(parent)) parent = path.dirname(parent);
    const relation = path.relative(root, fs.realpathSync.native(parent));
    if (relation.startsWith('..') || path.isAbsolute(relation))
      throw new Error('Retained files escaped this profile.');
    return file;
  }
  function metadata(relative, maximum) {
    const file = owned(relative);
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum)
      throw new Error('Retained file needs recovery.');
    const bytes = fs.readFileSync(file);
    if (bytes.length !== stat.size || bytes.length > maximum)
      throw new Error('Retained file changed while inspecting.');
    return { name: relative, bytes: bytes.length, sha256: digest(bytes) };
  }
  function removeFiles(selected, maximum) {
    // Validate the entire set before the first deletion, then each exact file.
    for (const file of selected)
      if (!equal(metadata(file.name, maximum), file)) throw new Error('Selected file changed.');
    for (const file of selected) {
      if (!equal(metadata(file.name, maximum), file)) throw new Error('Selected file changed.');
      fs.unlinkSync(owned(file.name));
    }
  }
  const otherAnswer = () =>
    assistant().state.messages.some(
      (m) => m.status === 'thinking' && !/^\/privacy(?:\s|$)/.test(m.text || ''),
    )
      ? ['An assistant answer still uses retained context']
      : [];
  function currentResearch() {
    if (!research) throw new Error('Research retention controls are unavailable.');
    const live = research();
    const disk = store.readStore(owned('research.json'), {
      missing: () => ({ version: 1, entries: [], receipts: {} }),
    }).value;
    if (!equal(disk, live.state))
      throw new Error('Research changed independently; preserve the original journal.');
    return live;
  }
  function extracts(sourceId) {
    return currentResearch()
      .state.entries.filter((e) => e.scope.sourceId === sourceId)
      .map((e) => ({ id: e.id, records: structuredClone(e.records) }));
  }
  function extractDependencies(sourceId) {
    const live = currentResearch(),
      ids = new Set(
        live.state.entries.filter((e) => e.scope.sourceId === sourceId).map((e) => e.id),
      );
    const derived = reflections?.().state.checkpoints.some(
      (c) =>
        c.context?.records?.length &&
        (ids.has(c.context?.source?.researchId) || c.context?.source?.sourceId === sourceId),
    );
    return [
      ...otherAnswer(),
      ...(live.state.entries.some((e) => ids.has(e.id) && (live.pending.has(e.id) || e.pending))
        ? ['A selected source read is still running']
        : []),
      ...(derived
        ? [
            'Reflection checkpoints still retain selected source statements; use their separate retention controls first',
          ]
        : []),
    ];
  }
  function orphanImages() {
    const folder = owned('attachments');
    if (!fs.existsSync(folder)) return { files: [], referencedFiles: 0 };
    const st = fs.lstatSync(folder);
    if (!st.isDirectory() || st.isSymbolicLink() || fs.realpathSync.native(folder) !== folder)
      throw new Error('Attachment directory needs recovery.');
    const names = fs.readdirSync(folder).sort();
    if (names.length > 2048 || names.some((name) => !imageName.test(name)))
      throw new Error('Attachment inventory exceeds its reviewed format.');
    const referenced = new Set();
    function visit(value) {
      if (typeof value === 'string') {
        const name = path.basename(value);
        if (imageName.test(name)) referenced.add(name);
      } else if (Array.isArray(value)) for (const child of value) visit(child);
      else if (value && typeof value === 'object')
        for (const child of Object.values(value)) visit(child);
    }
    // Includes original intents and replay receipts, not just visible messages.
    for (const name of Object.keys(store.versions)) {
      if (name === 'privacy.json') continue;
      const file = owned(name);
      if (fs.existsSync(file)) visit(store.readStore(file).value);
    }
    visit(assistant().state);
    if (messages) visit(messages().state);
    for (const name of attachments?.liveReferences || []) referenced.add(name);
    return {
      files: names
        .filter((name) => !referenced.has(name))
        .map((name) => metadata('attachments/' + name, 20 * 1024 * 1024)),
      referencedFiles: names.filter((name) => referenced.has(name)).length,
    };
  }
  const backups = () =>
    ['logs/app.log.1', 'logs/app.log.2'].map((name) => metadata(name, 512 * 1024)).filter(Boolean);
  return {
    'source-extracts': {
      requiresDisconnectedSource: true,
      read: extracts,
      dependencies: extractDependencies,
      remove: (sourceId, selected) => {
        if (extractDependencies(sourceId).length || !equal(extracts(sourceId), selected))
          throw new Error('Extract dependencies changed.');
        const live = currentResearch();
        live.change((next) => {
          for (const entry of next.entries)
            if (entry.scope.sourceId === sourceId) entry.records = [];
        });
        currentResearch(); // Disk, validation and in-memory state must agree.
      },
      removed: (value) => value.every((e) => e.records.length === 0),
      kept: 'Read grants, scan/cursor and replay receipts, original chats, notes, conversation and other derivative classes remain. No source is reconnected.',
    },
    'orphan-attachments': {
      exportable: false,
      read: orphanImages,
      dependencies: () => [
        ...otherAnswer(),
        ...(messages?.().active.size ? ['An image dispatch is still running'] : []),
      ],
      remove: (_, selected) => {
        if (!equal(orphanImages(), selected)) throw new Error('Image references changed.');
        removeFiles(selected.files, 20 * 1024 * 1024);
      },
      removed: (value) => value.files.length === 0,
      kept: 'All referenced images, draft/history/receipt references, source chats and external copies remain.',
    },
    'diagnostic-backups': {
      exportable: false,
      read: backups,
      dependencies: () => [],
      remove: (_, selected) =>
        diagnostics().withRetentionPaused(() => removeFiles(selected, 512 * 1024)),
      removed: (value) => value.length === 0,
      kept: 'The active app log, other loggers, exported diagnostic copies and action/replay receipts remain. Future diagnostics continue.',
    },
    'voice-configuration': {
      exportable: false,
      read: () => metadata('voice-provider.enc', 4096),
      dependencies: () =>
        voice().live ? ['End the current voice session before removing its key'] : [],
      remove: (_, selected) => {
        if (voice().live) throw new Error('Voice is still active.');
        if (selected) removeFiles([selected], 4096);
      },
      removed: (value) => value === null,
      kept: 'Voice session/usage checkpoints and provider-side account data remain. This removes the local encrypted key only.',
    },
  };
}
module.exports = { retainedAdapters };
