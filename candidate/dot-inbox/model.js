(function (root, factory) {
  const value = factory();
  if (typeof module === 'object' && module.exports) module.exports = value;
  else root.DotInbox = value;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const QUEUED_SOURCE = 'queue:no-source';
  const sourceMatches = (item, sourceId) =>
    item.sources.some((s) => s.id === sourceId) ||
    (item.kind === 'local' && item.sources.length === 0 && sourceId === QUEUED_SOURCE);
  const identity = (item, sourceId = item.primarySourceId) =>
    JSON.stringify([item.owner?.id, item.taskKey, sourceId]);
  const draftIdentity = (item, sourceId = item.primarySourceId) =>
    JSON.stringify([item.owner?.id, item.id, item.taskKey, sourceId, item.contextRevision]);
  const binding = (item, sourceId) => ({
    ownerId: item.owner.id,
    id: item.id,
    taskKey: item.taskKey,
    sourceId,
    contextRevision: item.contextRevision,
  });
  const placeholder = (ref) => ({
    owner: { id: ref.ownerId, name: 'Saved computer ' + ref.ownerId.slice(-8), online: false },
    id: ref.id,
    taskKey: ref.taskKey,
    contextRevision: ref.contextRevision,
    title: 'Saved draft',
    chatName: 'Earlier conversation',
    primarySourceId: ref.sourceId,
    sources: [
      {
        id: ref.sourceId,
        title: 'Saved conversation',
        body: 'Current source context must be loaded and validated before acting.',
      },
    ],
    provenance: { mode: 'synthetic', channel: 'Recovered draft' },
  });
  const needs = (item) =>
    item.status === 'needs' ||
    (['waiting', 'blocked'].includes(item.status) && item.waitingOn?.kind === 'you');
  const actionable = (item) => !item.done && !item.reviewed && !item.snoozed;
  function uniqueCards(items) {
    const found = new Map();
    for (const card of items) {
      const key = JSON.stringify([card.owner?.id, card.id, card.taskKey]);
      if (!found.has(key)) found.set(key, card);
    }
    return [...found.values()];
  }
  function rank(item) {
    if (!actionable(item)) return 8;
    if (needs(item)) return item.urgent ? 0 : 1;
    if (item.urgent) return 2;
    if (item.readyForReview || item.status === 'ready') return 3;
    return { blocked: 4, queued: 5, starting: 5, working: 5, waiting: 6 }[item.status] ?? 7;
  }
  function ordered(items) {
    return [...items].sort((a, b) => rank(a) - rank(b) || b.at - a.at || a.id.localeCompare(b.id));
  }
  function label(item) {
    const status = item.done
      ? 'Done'
      : item.snoozed
        ? 'Snoozed for 1h'
        : item.reviewed
          ? 'Reviewed'
          : item.label || 'Status unavailable';
    return (
      status +
      (item.owner?.online === false
        ? item.provenance?.mode === 'read-only'
          ? ' · context cached'
          : ' · computer offline'
        : '')
    );
  }
  function briefing(cards, question = 'What needs me?', { loading = false, error = '' } = {}) {
    const query = String(question).trim().toLowerCase();
    let kind;
    if (/^(send|reply|call|text|delete|complete|mark|snooze|remind|schedule)\b/.test(query))
      kind = 'unsupported';
    else if (/urgent|priority|priorities/.test(query)) kind = 'urgent';
    else if (/waiting|wait on|blocked/.test(query) && !/on me|for me/.test(query)) kind = 'waiting';
    else if (/all|changed|updates|overview|everything/.test(query)) kind = 'updates';
    else if (/needs? me|need me|on me|for me|need.*(do|reply)|attention|approval/.test(query))
      kind = 'needs';
    else kind = 'unsupported';
    if (loading)
      return { kind, text: 'Loading your recorded updates…', entries: [], unavailable: true };
    if (error)
      return {
        kind,
        text: 'I cannot refresh the inbox right now. ' + error,
        entries: [],
        unavailable: true,
      };
    if (kind === 'unsupported')
      return {
        kind,
        text: 'I can show what needs you, what is urgent, what is waiting on others, or all current updates. Open a source conversation to review or draft a reply.',
        entries: [],
      };
    const current = ordered(uniqueCards(cards)).filter(actionable);
    const selected = current.filter((item) =>
      kind === 'needs'
        ? needs(item) || (item.readyForReview && !['waiting', 'blocked'].includes(item.status))
        : kind === 'urgent'
          ? item.urgent === true
          : kind === 'waiting'
            ? ['waiting', 'blocked'].includes(item.status) && item.waitingOn?.kind !== 'you'
            : true,
    );
    const text = !selected.length
      ? {
          needs: 'Nothing in this view needs you right now.',
          urgent: 'No unreviewed urgent items in this view.',
          waiting: 'No recorded tasks waiting on someone else in this view.',
          updates: 'You are caught up in this view. Reviewed and snoozed updates remain in Queue.',
        }[kind]
      : kind === 'needs'
        ? selected.length +
          ' update' +
          (selected.length === 1 ? ' needs' : 's need') +
          ' you. Urgent requests come first.'
        : kind === 'urgent'
          ? selected.length + ' urgent update' + (selected.length === 1 ? '' : 's') + ' to inspect.'
          : kind === 'waiting'
            ? 'These tasks are waiting. The recorded status below identifies who, or says when the owner is unclear.'
            : 'Here are your current unreviewed updates, with requests for you first.';
    return {
      kind,
      text,
      entries: selected.map((item) => ({
        ref: binding(item, item.sources.length ? item.primarySourceId : QUEUED_SOURCE),
        sender: item.provenance.sender || item.chatName,
        title: item.title,
        summary: item.summary,
        status: (item.urgent ? 'Urgent · ' : '') + label(item),
        channel: item.provenance.channel,
        owner: item.owner.name,
        mode: item.provenance.mode,
        hasConversation: item.sources.length > 0,
      })),
    };
  }
  function resolveBriefingReference(cards, ref) {
    return cards.find(
      (item) =>
        item.owner?.id === ref.ownerId &&
        item.id === ref.id &&
        item.taskKey === ref.taskKey &&
        item.contextRevision === ref.contextRevision &&
        sourceMatches(item, ref.sourceId),
    );
  }
  class InboxModel {
    constructor(storage = null) {
      this.snapshot = null;
      this.opened = false;
      this.view = 'inbox';
      this.returnView = 'inbox';
      this.selection = null;
      this.drafts = new Map();
      this.pending = new Set();
      this.epoch = null;
      this.revision = 0;
      this.error = '';
      this.storage = storage;
      this.storageError = '';
      this.bindings = new Map();
      this.intents = new Map();
      this.assistant = { question: 'What needs me?', draft: '' };
      this.recovered = false;
      if (storage) {
        try {
          const raw = storage.getItem('work-updates.dot-inbox.v1');
          if (raw) this.restore(JSON.parse(raw));
        } catch {
          this.storageReadFailed = true;
          this.storageError =
            'Local recovery storage is unavailable. Draft edits are only in memory; actions are paused.';
        }
      }
    }
    export() {
      return {
        version: 1,
        drafts: [...this.drafts],
        bindings: [...this.bindings],
        intents: [...this.intents],
        selection: this.selection ? binding(this.selection.item, this.selection.sourceId) : null,
        opened: this.opened,
        view: this.view,
        returnView: this.returnView,
        assistant: { ...this.assistant },
      };
    }
    restore(value) {
      if (
        value.version !== 1 ||
        !Array.isArray(value.drafts) ||
        !Array.isArray(value.bindings) ||
        !Array.isArray(value.intents)
      )
        throw new Error('Invalid recovery record.');
      this.bindings = new Map(
        value.bindings.filter(
          ([, ref]) => ref && Object.values(ref).every((v) => typeof v === 'string'),
        ),
      );
      this.drafts = new Map(
        value.drafts.filter(
          ([key, text]) =>
            this.bindings.has(key) && typeof text === 'string' && text.length <= 12000,
        ),
      );
      this.intents = new Map(
        value.intents.filter(([, intent]) => intent?.eventId && this.bindings.has(intent.key)),
      );
      if (value.selection) {
        const item = placeholder(value.selection);
        this.selection = {
          item,
          sourceId: value.selection.sourceId,
          key: draftIdentity(item, value.selection.sourceId),
        };
      }
      this.opened = value.opened === true;
      this.view = ['inbox', 'queue', 'relationships', 'conversation', 'assistant'].includes(
        value.view,
      )
        ? value.view
        : 'inbox';
      this.returnView = ['inbox', 'queue', 'relationships', 'assistant'].includes(value.returnView)
        ? value.returnView
        : 'inbox';
      if (value.assistant) {
        if (
          typeof value.assistant.question !== 'string' ||
          value.assistant.question.length > 2000 ||
          typeof value.assistant.draft !== 'string' ||
          value.assistant.draft.length > 2000
        )
          throw new Error('Invalid assistant recovery.');
        this.assistant = { question: value.assistant.question, draft: value.assistant.draft };
      }
      this.recovered = true;
    }
    persist() {
      if (!this.storage) return true;
      if (this.storageReadFailed) return false;
      try {
        this.storage.setItem('work-updates.dot-inbox.v1', JSON.stringify(this.export()));
        this.storageError = '';
        return true;
      } catch {
        this.storageError =
          'Local recovery storage is unavailable. Draft edits are only in memory; actions are paused.';
        return false;
      }
    }
    retryStorage() {
      if (this.storageReadFailed) {
        try {
          const value = this.storage.getItem('work-updates.dot-inbox.v1');
          const recovered = new InboxModel();
          if (value) recovered.restore(JSON.parse(value));
          this.drafts = new Map([...recovered.drafts, ...this.drafts]);
          this.bindings = new Map([...recovered.bindings, ...this.bindings]);
          this.intents = new Map([...recovered.intents, ...this.intents]);
          this.storageReadFailed = false;
        } catch {
          return false;
        }
      }
      return this.persist();
    }
    begin(token, action, eventId) {
      const intent = { ...token, action, eventId, state: 'inFlight', ownerAccepted: false };
      this.intents.set(eventId, intent);
      if (!this.persist()) {
        this.intents.delete(eventId);
        throw new Error(this.storageError);
      }
      this.pending.add(token.key);
      return intent;
    }
    reconcile(events = []) {
      for (const intent of this.intents.values()) {
        const event = events.find((e) => e.eventId === intent.eventId);
        if (
          event &&
          ['ownerId', 'id', 'taskKey', 'sourceId', 'contextRevision', 'action'].every(
            (k) => event[k] === intent[k],
          )
        ) {
          const newlyAccepted = !intent.ownerAccepted && event.ownerAccepted;
          Object.assign(intent, {
            state: event.state,
            ownerAccepted: event.ownerAccepted,
            providerAccepted: event.providerAccepted,
          });
          if (newlyAccepted) this.finish(intent, intent.action === 'reply');
          if (event.state === 'inFlight') this.pending.add(intent.key);
          if (event.state !== 'inFlight') this.pending.delete(intent.key);
        } else if (intent.state === 'inFlight') {
          intent.state = 'uncertain';
          this.pending.delete(intent.key);
        }
      }
    }
    replyBlocked() {
      return [...this.intents.values()].some(
        (i) =>
          i.key === this.selection?.key &&
          i.action === 'reply' &&
          (['inFlight', 'uncertain'].includes(i.state) ||
            (i.ownerAccepted && i.text === this.draft())),
      );
    }
    recoveredDrafts() {
      return [...this.drafts]
        .filter(([, text]) => text)
        .map(([key, text]) => ({ key, text, ref: this.bindings.get(key) }));
    }
    openSaved(key) {
      const ref = this.bindings.get(key);
      if (!ref) return false;
      const current = this.snapshot?.cards.find(
        (c) =>
          c.owner.id === ref.ownerId &&
          c.id === ref.id &&
          c.taskKey === ref.taskKey &&
          c.contextRevision === ref.contextRevision &&
          sourceMatches(c, ref.sourceId),
      );
      this.open(current || placeholder(ref), ref.sourceId);
      return true;
    }
    update(snapshot, { reconnect = false } = {}) {
      const version = snapshot.stateVersion;
      if (!version || !Number.isSafeInteger(version.revision) || version.revision < 1)
        throw new Error('The inbox did not provide an ordered snapshot.');
      if (!reconnect && this.epoch && version.epoch !== this.epoch)
        throw new Error('The preview restarted. Reconnect to its current inbox.');
      if (!reconnect && version.revision <= this.revision) return false;
      this.epoch = version.epoch;
      this.revision = version.revision;
      this.snapshot = clone(snapshot);
      this.error = '';
      if (this.recovered && this.selection) {
        const selected = this.selection.item;
        const fresh = snapshot.cards.find(
          (c) =>
            c.owner.id === selected.owner.id &&
            c.id === selected.id &&
            c.taskKey === selected.taskKey &&
            c.contextRevision === selected.contextRevision &&
            sourceMatches(c, this.selection.sourceId),
        );
        if (fresh) this.selection.item = clone(fresh);
        this.recovered = false;
      }
      this.reconcile(snapshot.preview?.actionEvents || []);
      return true;
    }
    toggle() {
      this.opened = !this.opened;
    }
    close() {
      this.opened = false;
    }
    navigate(view) {
      if (!['inbox', 'queue', 'relationships', 'assistant'].includes(view))
        throw new Error('Unknown view.');
      this.view = view;
    }
    assistantDraft(value) {
      if (value !== undefined) {
        this.assistant.draft = String(value).slice(0, 2000);
        this.persist();
      }
      return this.assistant.draft;
    }
    ask(question = this.assistant.draft) {
      const text = String(question).trim().slice(0, 2000);
      if (!text) return false;
      this.assistant = { question: text, draft: '' };
      this.navigate('assistant');
      this.persist();
      return true;
    }
    open(item, sourceId = item.primarySourceId) {
      if (item.kind === 'local' && item.sources.length === 0) sourceId = QUEUED_SOURCE;
      if (!sourceMatches(item, sourceId) || !item.owner?.id)
        throw new Error('Choose an identified source conversation.');
      if (this.view !== 'conversation') this.returnView = this.view;
      this.selection = { item: clone(item), sourceId, key: draftIdentity(item, sourceId) };
      this.bindings.set(this.selection.key, binding(item, sourceId));
      this.view = 'conversation';
      this.opened = true;
    }
    back() {
      this.view = this.returnView;
    }
    current() {
      if (!this.selection) return null;
      const selected = this.selection;
      const item = this.snapshot?.cards.find(
        (c) =>
          c.owner?.id === selected.item.owner.id &&
          c.id === selected.item.id &&
          c.taskKey === selected.item.taskKey,
      );
      if (!item)
        return {
          item: selected.item,
          sourceId: selected.sourceId,
          stale: true,
          noConversation: selected.item.kind === 'local' && selected.item.sources.length === 0,
          reason: this.latest()
            ? 'This chat has a different current task. Review it before replying. Your draft is saved.'
            : !this.snapshot?.devices?.some((d) => d.id === selected.item.owner.id)
              ? 'The owning computer is no longer available. Your unsent draft is saved.'
              : 'This task is no longer in the queue. Your unsent draft is saved.',
        };
      if (item.kind === 'local' && item.sources.length === 0)
        return {
          item,
          sourceId: selected.sourceId,
          stale: true,
          noConversation: true,
          reason: 'This queued task has no source conversation yet. Replies are disabled.',
        };
      if (!sourceMatches(item, selected.sourceId))
        return {
          item: selected.item,
          sourceId: selected.sourceId,
          stale: true,
          reason: 'This source conversation changed. Your unsent draft is saved.',
        };
      if (item.contextRevision !== selected.item.contextRevision)
        return {
          item: selected.item,
          sourceId: selected.sourceId,
          stale: true,
          reason: 'A newer update is available. Review it before replying. Your draft is saved.',
        };
      return { item, sourceId: selected.sourceId, stale: false, reason: '' };
    }
    latest() {
      if (!this.selection) return null;
      const old = this.selection.item;
      return (
        this.snapshot?.cards.find((c) => c.owner?.id === old.owner.id && c.id === old.id) || null
      );
    }
    adoptLatest() {
      const latest = this.latest();
      if (!latest) return false;
      const sourceId = latest.sources.some((s) => s.id === this.selection.sourceId)
        ? this.selection.sourceId
        : latest.primarySourceId;
      this.open(latest, sourceId);
      return true;
    }
    draft(value) {
      if (!this.selection) return '';
      if (value !== undefined) {
        this.drafts.set(this.selection.key, value);
        this.persist();
      }
      return this.drafts.get(this.selection.key) || '';
    }
    token() {
      const current = this.current();
      if (!current || current.stale || !current.item.owner.online)
        throw new Error('Reopen a current online conversation first.');
      if (current.item.provenance.mode !== 'synthetic')
        throw new Error('Live Codex conversations are read-only in this preview.');
      return {
        ownerId: current.item.owner.id,
        id: current.item.id,
        taskKey: current.item.taskKey,
        sourceId: current.sourceId,
        contextRevision: current.item.contextRevision,
        key: this.selection.key,
        text: this.draft(),
      };
    }
    finish(token, accepted) {
      this.pending.delete(token.key);
      if (accepted && this.drafts.get(token.key) === token.text) this.drafts.delete(token.key);
      // A late result never reopens or changes another selected conversation.
      if (accepted && this.selection?.key === token.key && this.view === 'conversation')
        this.adoptLatest();
    }
    items() {
      return ordered(this.snapshot?.cards || []);
    }
    attention() {
      const items = this.items().filter((c) => actionable(c) && (needs(c) || c.readyForReview));
      return {
        count: items.length,
        needs: items.filter(needs).length,
        urgent: items.some((c) => needs(c) && c.urgent),
      };
    }
  }
  return {
    InboxModel,
    identity,
    draftIdentity,
    ordered,
    rank,
    label,
    needs,
    actionable,
    uniqueCards,
    briefing,
    resolveBriefingReference,
  };
});
