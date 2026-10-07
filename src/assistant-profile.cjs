'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { readStore, atomicJSON } = require('./private-store.cjs');
const digest = (b) => crypto.createHash('sha256').update(b).digest('hex');
const bounded = (v, max) =>
  typeof v === 'string' &&
  v.trim().length > 0 &&
  v.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(v);
function validate(s) {
  if (
    s?.version !== 1 ||
    !/^[-a-f0-9]{36}$/.test(s.id || '') ||
    !bounded(s.actorId, 200) ||
    !bounded(s.displayName, 48) ||
    !['hyphen', 'initials'].includes(s.avatarStyle) ||
    !bounded(s.initials, 4) ||
    typeof s.reducedMotion !== 'boolean' ||
    !Number.isSafeInteger(s.updatedAt) ||
    s.updatedAt <= 0
  )
    throw new Error('Unsupported assistant profile; preserve the original and repair a copy.');
}
class AssistantProfile {
  constructor({ directory, actorId, now = Date.now, onChange = () => {} }) {
    Object.assign(this, { actorId, now, onChange });
    this.file = path.join(directory, 'profile.json');
    const saved = readStore(this.file);
    this.state = saved.missing
      ? {
          version: 1,
          id: crypto.randomUUID(),
          actorId,
          displayName: 'Hyphen',
          avatarStyle: 'hyphen',
          initials: 'H',
          reducedMotion: false,
          updatedAt: now(),
        }
      : saved.value;
    validate(this.state);
    if (this.state.actorId !== actorId) throw new Error('Profile belongs to another local owner.');
    if (saved.missing) atomicJSON(this.file, this.state);
    this.diskHash = digest(fs.readFileSync(this.file));
    this.failed = false;
  }
  update(i, patch) {
    if (
      i?.actorId !== this.actorId ||
      i.role !== 'human' ||
      i.authority !== 'accepted_human' ||
      !/^[-a-f0-9]{36}$/.test(i.messageId || '')
    )
      throw new Error('Profile changes require the current human.');
    if (
      !patch ||
      Object.keys(patch).some(
        (k) => !['displayName', 'avatarStyle', 'initials', 'reducedMotion'].includes(k),
      )
    )
      throw new Error('Only presentation preferences can be changed.');
    if (this.failed || digest(fs.readFileSync(this.file)) !== this.diskHash)
      throw new Error('Profile changed outside this session; updates are held.');
    const next = { ...this.state, ...patch, updatedAt: this.now() };
    validate(next);
    try {
      atomicJSON(this.file, next);
      const bytes = fs.readFileSync(this.file);
      if (JSON.stringify(JSON.parse(bytes)) !== JSON.stringify(next))
        throw new Error('Profile save is unconfirmed.');
      this.state = next;
      this.diskHash = digest(bytes);
    } catch (e) {
      this.failed = true;
      throw e;
    }
    this.onChange();
    return this.snapshot();
  }
  snapshot() {
    const { id, displayName, avatarStyle, initials, reducedMotion, updatedAt } = this.state;
    return {
      schema: 1,
      id,
      displayName,
      avatarStyle,
      initials,
      reducedMotion,
      updatedAt,
      scope: 'This local assistant; not a task, device or account identity',
    };
  }
}
function capabilities({
  assistant,
  executors,
  documents,
  voice,
  browsers,
  peerContract,
  helper,
} = {}) {
  const features = [
    {
      name: 'Local assistant text',
      state: assistant ? 'supported' : 'unsupported',
      provider: assistant ? 'Codex' : null,
      model: assistant?.provider?.model || null,
      accountEntitlement: 'unverified',
      lastVerifiedAt: null,
    },
    {
      name: 'Task execution',
      state: executors ? 'explicit_binding_required' : 'unsupported',
      lastVerifiedAt: null,
      reason: 'Each account, profile, workspace and server binding is checked before dispatch',
    },
    {
      name: 'Documents',
      state: documents ? 'local_private_text' : 'unsupported',
      lastVerifiedAt: null,
      externalSharing: false,
    },
    {
      name: 'Browser',
      state: browsers ? 'private_owned_session' : 'unsupported',
      lastVerifiedAt: null,
      existingProfiles: false,
    },
    {
      name: 'Voice',
      state: voice?.inspect().support.configured ? 'configured_unverified' : 'unsupported',
      lastVerifiedAt: null,
      billing: 'Separate provider API',
    },
    {
      name: 'Phone assistant',
      state: peerContract?.assistant === true ? 'negotiated' : 'unsupported',
      lastVerifiedAt: null,
      reason: 'Phone task controls do not establish assistant or voice support',
    },
  ];
  return {
    schema: 1,
    observedAt: Date.now(),
    features,
    channels: [
      { name: 'Local desktop', assistant: !!assistant, voice: !!voice },
      {
        name: 'Paired phone',
        commands: peerContract?.commands || [],
        assistant: peerContract?.assistant === true,
        attachments: peerContract?.attachments === true,
        voice: false,
      },
    ],
    executors: (executors?.inspect?.() || [])
      .slice(-32)
      .map((e) => ({
        id: e.id,
        taskId: e.taskId,
        deviceId: e.deviceId,
        workspace: e.workspace,
        provider: e.provider,
        serverVersion: e.serverVersion,
        access: e.access,
        lastVerifiedAt: e.verifiedAt || null,
        verification: 'Binding recorded at grant; current account is rechecked before dispatch',
        online: 'unknown_until_next_handshake',
      })),
    appScopes: documents
      ? [
          {
            provider: 'local_private_text',
            scope: 'Explicitly imported private copies',
            actions: ['read', 'draft', 'apply', 'schedule'],
            externalSharing: false,
          },
        ]
      : [],
    helperConnected: typeof helper?.connected === 'boolean' ? helper.connected : null,
    accountPlan: 'unknown',
    actualUsage: 'Inspect original provider usage; unknown costs are not zero',
    accountVerified: false,
  };
}
module.exports = { AssistantProfile, validate, capabilities };
