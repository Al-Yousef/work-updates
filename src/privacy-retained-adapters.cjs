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
  documents,
  browsers,
  browserVault,
}) {
  const root = fs.realpathSync.native(directory);
  function owned(relative) {
    const file = path.join(root, relative);
    let parent = path.dirname(file);
    for (;;) {
      try {
        const stat = fs.lstatSync(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new Error('Redirected retained directory requires recovery.');
        break;
      } catch (error) {
        if (error.code !== 'ENOENT' || path.dirname(parent) === parent) throw error;
        parent = path.dirname(parent);
      }
    }
    const relation = path.relative(root, fs.realpathSync.native(parent));
    if (relation.startsWith('..') || path.isAbsolute(relation))
      throw new Error('Retained files escaped this profile.');
    const canonical = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
    if (canonical(fs.realpathSync.native(parent)) !== canonical(parent))
      throw new Error('Redirected retained directory requires recovery.');
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
    const expected = (file) => ({ name: file.name, bytes: file.bytes, sha256: file.sha256 });
    // Validate the entire set before the first deletion, then each exact file.
    for (const file of selected)
      if (!equal(metadata(file.name, maximum), expected(file)))
        throw new Error('Selected file changed.');
    for (const file of selected) {
      if (!equal(metadata(file.name, maximum), expected(file)))
        throw new Error('Selected file changed.');
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
  const fileBytes = (files) => files.reduce((total, file) => total + file.bytes, 0);
  const fileSummary = (files) => ({
    files: files.slice(0, 16).map(({ name, bytes, origin, title }) => ({
      name,
      bytes,
      ...(origin ? { origin } : {}),
      ...(title ? { title } : {}),
    })),
    omittedFiles: Math.max(0, files.length - 16),
  });
  function documentCopies() {
    const live = documents();
    const saved = store.readStore(owned('documents.json'), {
      missing: () => ({ version: 1, documents: [], drafts: [], receipts: [], schedules: [] }),
    }).value;
    if (!equal(saved, live.state)) throw new Error('Document journal changed independently.');
    return live.state.documents.flatMap((d) => {
      const file = metadata('document-library/' + d.id + '.' + d.extension, 512 * 1024);
      return file ? [{ ...file, title: d.title }] : [];
    });
  }
  const documentDependencies = () => [
    ...otherAnswer(),
    ...(documents().busy ||
    documents().state.receipts.some((r) => ['applying', 'unconfirmed'].includes(r.status))
      ? ['A document write is running or unconfirmed']
      : []),
    ...(documents().state.schedules.some((r) => r.status === 'active')
      ? ['Cancel active document schedules before removing their output copies']
      : []),
  ];
  function savedLogins() {
    // Decryption stays inside the vault. Only current-owner file metadata is
    // projected; no cookie values are returned to previews or exports.
    return browserVault.inspectOwned(browsers().actorId);
  }
  const loginDependencies = () =>
    browsers().live.size ? ['Close private browser sessions before removing saved login keys'] : [];
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
      bytes: (value) => fileBytes(value.files),
      summary: (value) => ({
        ...fileSummary(value.files),
        referencedFilesKept: value.referencedFiles,
      }),
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
      bytes: fileBytes,
      summary: fileSummary,
      dependencies: () => [],
      remove: (_, selected) =>
        diagnostics().withRetentionPaused(() => removeFiles(selected, 512 * 1024)),
      removed: (value) => value.length === 0,
      kept: 'The active app log, other loggers, exported diagnostic copies and action/replay receipts remain. Future diagnostics continue.',
    },
    'voice-configuration': {
      exportable: false,
      read: () => metadata('voice-provider.enc', 4096),
      bytes: (value) => value?.bytes || 0,
      summary: (value) => ({ files: value ? [{ name: value.name, bytes: value.bytes }] : [] }),
      dependencies: () =>
        voice().live ? ['End the current voice session before removing its key'] : [],
      remove: (_, selected) => {
        if (voice().live) throw new Error('Voice is still active.');
        if (selected) removeFiles([selected], 4096);
      },
      removed: (value) => value === null,
      kept: 'Voice session/usage checkpoints and provider-side account data remain. This removes the local encrypted key only.',
    },
    'document-copies': {
      exportable: false,
      read: documentCopies,
      bytes: fileBytes,
      summary: fileSummary,
      dependencies: documentDependencies,
      remove: (_, selected) => {
        if (documentDependencies().length || !equal(documentCopies(), selected))
          throw new Error('Document dependencies changed.');
        removeFiles(selected, 512 * 1024);
      },
      removed: (value) => value.length === 0,
      kept: 'Original import files, document identities, draft/replacement text, schedules, action/replay receipts and exported copies remain. Future requests must import a new copy explicitly.',
    },
    'browser-logins': {
      exportable: false,
      read: savedLogins,
      bytes: fileBytes,
      summary: fileSummary,
      dependencies: loginDependencies,
      remove: (_, selected) => {
        if (loginDependencies().length || !equal(savedLogins(), selected))
          throw new Error('Browser/login dependencies changed.');
        removeFiles(selected, 1024 * 1024);
      },
      removed: (value) => value.length === 0,
      kept: 'Other owners encrypted logins, browser/action metadata and provider-side login sessions remain. Cookie values are never exported.',
    },
  };
}
module.exports = { retainedAdapters };
