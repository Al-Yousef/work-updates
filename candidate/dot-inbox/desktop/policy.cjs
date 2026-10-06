'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { draftIdentity } = require('../model.js');
const SCHEME = 'work-updates-review';
const ORIGIN = SCHEME + '://app';
const APP_ID = 'io.workupdates.desktop.review';
const APP_NAME = 'Work Updates Review';
const REF_FIELDS = ['ownerId', 'id', 'taskKey', 'sourceId', 'contextRevision'];
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
function privateRoot(allowed, requested) {
  const base = fs.realpathSync(allowed);
  if (base.toLowerCase() !== path.resolve(allowed).toLowerCase())
    throw new Error('Review root cannot be redirected.');
  const target = path.resolve(requested);
  if (!inside(base, target) || target === base)
    throw new Error('Choose a private review subdirectory.');
  // Resolve each existing ancestor before creating anything, including Windows junctions.
  let ancestor = target;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (!inside(base, fs.realpathSync(ancestor)))
    throw new Error('Review data cannot escape its private root.');
  fs.mkdirSync(target, { recursive: true });
  if (!inside(base, fs.realpathSync(target)))
    throw new Error('Review data cannot escape its private root.');
  return fs.realpathSync(target);
}
function atomicJson(file, value) {
  const temporary = file + '.pending';
  for (const target of [file, temporary])
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink())
      throw new Error('Recovery files cannot be redirected.');
  const fd = fs.openSync(temporary, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
}
function ref(value) {
  if (
    !value ||
    !REF_FIELDS.every(
      (k) => typeof value[k] === 'string' && value[k].length > 0 && value[k].length <= 1024,
    )
  )
    throw new Error('Invalid recovery binding.');
  return Object.fromEntries(REF_FIELDS.map((k) => [k, value[k]]));
}
function keyFor(value) {
  return draftIdentity(
    {
      owner: { id: value.ownerId },
      id: value.id,
      taskKey: value.taskKey,
      contextRevision: value.contextRevision,
    },
    value.sourceId,
  );
}
function recoveryRecord(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 2000000)
    throw new Error('Invalid recovery size.');
  const value = JSON.parse(raw);
  if (
    value.version !== 1 ||
    !['drafts', 'bindings', 'intents'].every(
      (k) => Array.isArray(value[k]) && value[k].length <= 2000,
    )
  )
    throw new Error('Invalid recovery record.');
  const bindings = value.bindings.map(([key, value]) => {
    const bound = ref(value);
    if (key !== keyFor(bound)) throw new Error('Recovery key does not match its binding.');
    return [key, bound];
  });
  const map = new Map(bindings);
  const drafts = value.drafts.map(([key, text]) => {
    if (!map.has(key) || typeof text !== 'string' || text.length > 12000)
      throw new Error('Invalid saved draft.');
    return [key, text];
  });
  const intents = value.intents.map(([id, intent]) => {
    const bound = ref(intent);
    if (
      !map.has(intent.key) ||
      intent.key !== keyFor(bound) ||
      typeof id !== 'string' ||
      id.length > 100 ||
      intent.eventId !== id ||
      !['reply', 'reviewed', 'snooze'].includes(intent.action) ||
      !['inFlight', 'accepted', 'uncertain', 'rejected'].includes(intent.state) ||
      typeof intent.text !== 'string' ||
      intent.text.length > 12000
    )
      throw new Error('Invalid saved action.');
    return [
      id,
      {
        ...bound,
        key: intent.key,
        text: intent.text,
        action: intent.action,
        eventId: id,
        state: intent.state,
        ownerAccepted: intent.ownerAccepted === true,
        providerAccepted: intent.providerAccepted === true,
      },
    ];
  });
  if (
    value.assistant &&
    !['question', 'draft'].every(
      (key) => typeof value.assistant[key] === 'string' && value.assistant[key].length <= 2000,
    )
  )
    throw new Error('Invalid assistant recovery.');
  return {
    version: 1,
    drafts,
    bindings,
    intents,
    selection: value.selection ? ref(value.selection) : null,
    assistant: {
      question: value.assistant?.question ?? 'What needs me?',
      draft: value.assistant?.draft ?? '',
    },
    opened: value.opened === true,
    view: ['inbox', 'queue', 'relationships', 'conversation', 'assistant'].includes(value.view)
      ? value.view
      : 'inbox',
    returnView: ['inbox', 'queue', 'relationships', 'assistant'].includes(value.returnView)
      ? value.returnView
      : 'inbox',
  };
}
function prepare(directory, seedDirectory) {
  const userData = privateRoot(directory, path.join(directory, 'user-data'));
  const receipts = privateRoot(directory, path.join(directory, 'receipts'));
  const client = path.join(directory, 'client-recovery.json');
  const initialized = path.join(directory, 'initialized.json');
  for (const file of [
    client,
    initialized,
    path.join(directory, 'placement.json'),
    path.join(receipts, 'recovery.json'),
    path.join(receipts, 'recovery.json.tmp'),
  ]) {
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink())
      throw new Error('Review recovery files cannot be redirected.');
  }
  if (!fs.existsSync(initialized)) {
    if (seedDirectory) {
      const seedClient = path.join(seedDirectory, 'client-recovery.json');
      const seedReceipts = path.join(seedDirectory, 'recovery.json');
      if (fs.existsSync(seedClient) && !fs.existsSync(client))
        atomicJson(client, recoveryRecord(fs.readFileSync(seedClient, 'utf8')));
      if (fs.existsSync(seedReceipts) && !fs.existsSync(path.join(receipts, 'recovery.json')))
        fs.copyFileSync(
          seedReceipts,
          path.join(receipts, 'recovery.json'),
          fs.constants.COPYFILE_EXCL,
        );
    }
    atomicJson(initialized, { version: 1, imported: !!seedDirectory });
  }
  return {
    directory,
    userData,
    receipts,
    client,
    placement: path.join(directory, 'placement.json'),
  };
}
function owns(event, window) {
  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    return false;
  try {
    const u = new URL(event.senderFrame.url);
    return (
      u.protocol === SCHEME + ':' &&
      u.host === 'app' &&
      ['/', '/index.html'].includes(u.pathname) &&
      !u.search
    );
  } catch {
    return false;
  }
}
function route(request) {
  const u = new URL(request.url);
  if (u.protocol !== SCHEME + ':' || u.host !== 'app' || u.username || u.password || u.search)
    throw new Error('Unexpected review route.');
  if (request.initiatorOrigin && request.initiatorOrigin !== ORIGIN)
    throw new Error('Unexpected review origin.');
  const staticPaths = [
    '/',
    '/index.html',
    '/app.js',
    '/model.js',
    '/style.css',
    '/base.css',
    '/icon.svg',
    '/desktop.css',
  ];
  const allowed =
    request.method === 'GET'
      ? [...staticPaths, '/api/state']
      : request.method === 'POST'
        ? ['/api/action', '/api/scenario']
        : [];
  if (!allowed.includes(u.pathname)) throw new Error('Review route is disabled.');
  if (request.method === 'POST' && request.headers.get('x-dot-preview') !== 'fixture')
    throw new Error('Only fixture actions are allowed.');
  return u.pathname;
}
module.exports = {
  SCHEME,
  ORIGIN,
  APP_ID,
  APP_NAME,
  inside,
  privateRoot,
  atomicJson,
  recoveryRecord,
  prepare,
  owns,
  route,
};
