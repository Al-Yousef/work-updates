'use strict';
const { InboxModel, needs, actionable, label, briefing, resolveBriefingReference } =
  window.DotInbox;
const desktop = window.dotDesktop;
const storage = {
  getItem: (key) => (desktop ? desktop.recovery.read() : localStorage.getItem(key)),
  setItem: (key, value) => {
    if (model.snapshot?.preview.storageFailure) throw new Error('Fixture storage failure');
    if (desktop) desktop.recovery.write(value);
    else localStorage.setItem(key, value);
  },
};
const model = new InboxModel(storage);
let nativeExpanded;
const $ = (id) => document.getElementById(id);
let scope = model.selection?.item.id.startsWith('live:') ? 'live' : 'fixtures',
  bodyKey = '',
  composing = false,
  fetching = false;
const receipts = new Map();
const scrollOffsets = new Map();
$('data-source').value = scope;
let renderedViewKey = '',
  scrollReplyKey = '';
function element(tag, text = '', attributes = {}) {
  const node = document.createElement(tag);
  node.textContent = text;
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
  return node;
}
function button(text, action, className = '') {
  const node = element('button', text, { type: 'button', class: className });
  node.addEventListener('click', action);
  return node;
}
function items() {
  return model
    .items()
    .filter(
      (item) => scope === 'all' || (scope === 'live') === (item.provenance.mode === 'read-only'),
    );
}
function focusContent() {
  $('content').focus({ preventScroll: true });
}
function open(item, sourceId) {
  model.open(item, sourceId);
  render();
  focusContent();
}
function deviceIcon(item) {
  const kind = item.owner.kind;
  const paths =
    kind === 'mac'
      ? '<rect x="7" y="6" width="18" height="14" rx="2"/><path d="m7 20-3 5h24l-3-5m-12 3h6"/>'
      : kind === 'pc'
        ? '<rect x="5" y="6" width="22" height="15" rx="2"/><path d="M16 21v5m-5 0h10"/>'
        : '<rect x="10" y="4" width="12" height="24" rx="3"/><path d="M14 7h4m-4 18h4"/>';
  const icon = element('span', '', { class: 'status-indicator', 'aria-hidden': 'true' });
  const tone = !item.owner.online
    ? 'unknown'
    : item.done
      ? 'done'
      : needs(item)
        ? 'needs'
        : item.status;
  icon.dataset.status = tone;
  icon.append(
    element('img', '', {
      class: 'app-icon',
      alt: '',
      src:
        'data:image/svg+xml;charset=utf-8,' +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" stroke="#f1f4f7" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
            paths +
            '</svg>',
        ),
    }),
  );
  icon.append(
    element('span', { needs: '!', ready: '•', waiting: 'Ⅱ', blocked: '−', done: '✓' }[tone] || '', {
      class: 'status-symbol',
    }),
  );
  return icon;
}
function card(item) {
  const wrap = element('article', '', {
    class: 'card-wrap',
    'data-owner': item.owner.id,
    'data-card': item.id,
  });
  const surface = element('div', '', { class: 'card' });
  const trigger = button('', () => open(item), 'card-trigger');
  trigger.setAttribute(
    'aria-label',
    [
      item.provenance.sender || item.chatName,
      item.title,
      item.owner.name,
      label(item),
      item.provenance.channel,
    ].join(' · '),
  );
  const header = element('span', '', { class: 'card-header' });
  const copy = element('span', '', { class: 'card-copy' });
  const line = element('span', '', { class: 'notification-line' });
  line.append(
    element('span', item.provenance.sender || item.chatName, { class: 'meta' }),
    element('span', item.provenance.mode === 'synthetic' ? 'Sample' : 'Read only', {
      class: 'kind-label',
    }),
  );
  copy.append(
    line,
    element('span', item.title, { class: 'card-title' }),
    element('span', item.summary, { class: 'card-summary' }),
    element('span', (item.urgent && actionable(item) ? 'Urgent · ' : '') + label(item), {
      class: 'card-statuses' + (item.urgent && actionable(item) ? ' urgent-label' : ''),
    }),
    element('span', item.provenance.channel + ' · ' + item.owner.name, { class: 'source-line' }),
  );
  header.append(deviceIcon(item), copy);
  trigger.append(header);
  surface.append(trigger);
  wrap.append(surface);
  return wrap;
}
function heading(title, subtitle) {
  const node = element('div', '', { class: 'view-heading' });
  node.append(element('h1', title), element('p', subtitle));
  return node;
}
function stateMessage(title, text, retry = false) {
  const node = element('div', '', { class: 'empty-state' });
  node.append(element('h2', title), element('p', text));
  if (retry) node.append(button('Reconnect preview', reconnect, 'primary'));
  return node;
}
function localBriefing(question = model.assistant.question) {
  return briefing(items(), question, {
    loading: !model.snapshot || model.snapshot.fixtureLoading,
    error:
      model.error ||
      model.snapshot?.fixtureError ||
      (scope === 'live' && model.snapshot?.preview.liveError) ||
      '',
  });
}
function showAssistant() {
  model.navigate('assistant');
  render();
  focusContent();
}
function askAssistant(question) {
  if (!model.ask(question)) return;
  // Asking the same question still clears the visible composer.
  bodyKey = '';
  render();
  $('assistant-reply')?.focus({ preventScroll: true });
}
function assistantConversation() {
  const response = localBriefing();
  const layout = element('div', '', { class: 'conversation-layout assistant-layout' });
  const top = element('div', '', { class: 'conversation-top' });
  const back = button(
    '‹',
    () => {
      model.navigate('inbox');
      render();
      focusContent();
    },
    'back-button',
  );
  back.setAttribute('aria-label', 'Back to inbox');
  const identity = element('div', '', { class: 'conversation-identity' });
  identity.append(
    element('h1', 'Assistant'),
    element('span', 'Local queue briefing · updates automatically', { class: 'source-line' }),
  );
  top.append(back, identity);
  layout.append(top);
  const scroll = element('div', '', { class: 'conversation-scroll assistant-scroll' });
  const messages = element('section', '', {
    class: 'message-list conversation-messages',
    'aria-label': 'Assistant briefing',
  });
  const question = element('div', '', { class: 'message user' });
  question.append(
    element('span', 'You', { class: 'message-speaker' }),
    element('span', model.assistant.question),
  );
  const answer = element('div', '', { class: 'message assistant' });
  answer.append(
    element('span', 'Current briefing', { class: 'message-speaker' }),
    element('span', response.text, { id: 'assistant-answer' }),
  );
  if (response.unavailable && model.snapshot) answer.append(button('Reconnect preview', reconnect));
  messages.append(question, answer);
  scroll.append(messages);
  if (scope === 'all' && model.snapshot?.preview.liveError)
    scroll.append(
      element('p', model.snapshot.preview.liveError, { class: 'state-banner', role: 'status' }),
    );
  for (const entry of response.entries) {
    const row = element('article', '', {
      class: 'briefing-item',
      'data-owner': entry.ref.ownerId,
      'data-card': entry.ref.id,
    });
    row.append(
      element('span', entry.sender, { class: 'message-speaker' }),
      element('h2', entry.title),
      element(
        'p',
        entry.summary?.length > 360 ? entry.summary.slice(0, 360) + '…' : entry.summary || '',
      ),
      element('p', entry.status, { class: 'briefing-status' }),
      element(
        'span',
        entry.channel +
          ' · ' +
          entry.owner +
          (entry.mode === 'synthetic' ? ' · Sample' : ' · Read only'),
        { class: 'source-line' },
      ),
    );
    const trigger = button(
      entry.hasConversation ? 'Open conversation' : 'View queued task',
      () => {
        const current = resolveBriefingReference(items(), entry.ref);
        if (!current) {
          notice('This update changed. Inspect the refreshed briefing before opening it.');
          render();
          return;
        }
        open(current, entry.ref.sourceId);
      },
      'briefing-source',
    );
    trigger.setAttribute(
      'aria-label',
      (entry.hasConversation ? 'Open conversation: ' : 'View queued task: ') +
        entry.sender +
        ' · ' +
        entry.owner,
    );
    row.append(trigger);
    scroll.append(row);
  }
  layout.append(scroll);
  const composer = element('form', '', {
    class: 'composer',
    'aria-label': 'Ask the local assistant',
  });
  const prompts = element('div', '', {
    class: 'assistant-prompts',
    'aria-label': 'Briefing questions',
  });
  for (const [text, question] of [
    ['Needs me', 'What needs me?'],
    ['Waiting', 'What am I waiting on?'],
    ['Urgent', 'What is urgent?'],
  ])
    prompts.append(button(text, () => askAssistant(question)));
  composer.append(prompts);
  const row = element('div', '', { class: 'compose-row' });
  const input = element('textarea', '', {
    id: 'assistant-reply',
    rows: '2',
    maxlength: '2000',
    'aria-label': 'Question draft for the assistant',
    placeholder: 'What needs me?',
  });
  input.value = model.assistantDraft();
  input.addEventListener('input', () => {
    model.assistantDraft(input.value);
    updateSend();
  });
  input.addEventListener('compositionstart', () => {
    composing = true;
  });
  input.addEventListener('compositionend', () => {
    composing = false;
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing) {
      event.preventDefault();
      askAssistant(input.value);
    }
  });
  const send = button('↑', () => askAssistant(input.value), 'primary');
  send.id = 'assistant-send';
  send.setAttribute('aria-label', 'Ask assistant');
  row.append(input, send);
  composer.append(
    row,
    element(
      'p',
      model.storageError
        ? 'Not saved · this question draft is only in memory.'
        : 'Answers from this inbox · Enter asks',
      { class: 'composer-note' },
    ),
  );
  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    askAssistant(input.value);
  });
  layout.append(composer);
  return layout;
}
function listView() {
  const queue = model.view === 'queue';
  const container = element('div');
  const visible = queue ? items() : items().filter(actionable);
  const waiting = visible.filter(needs).length;
  container.append(
    heading(
      queue ? 'Your queue' : 'Inbox',
      queue
        ? 'Tasks and their source conversations, including reviewed updates.'
        : waiting
          ? waiting + ' waiting on you · replies stay with their conversation'
          : 'Your conversations and work, in one place.',
    ),
  );
  const savedDrafts = model
    .recoveredDrafts()
    .filter((d) => scope === 'all' || (scope === 'live') === d.ref.id.startsWith('live:'));
  let draftsNode;
  if (savedDrafts.length) {
    const drafts = element('section', '', {
      class: 'saved-drafts',
      'aria-label': 'Local saved drafts',
    });
    drafts.append(element('h2', 'Saved drafts', { class: 'section-label' }));
    for (const draft of savedDrafts) {
      const fresh = model.snapshot?.cards.find(
        (c) =>
          c.owner.id === draft.ref.ownerId &&
          c.id === draft.ref.id &&
          c.taskKey === draft.ref.taskKey &&
          c.contextRevision === draft.ref.contextRevision,
      );
      const source = fresh?.sources.find((s) => s.id === draft.ref.sourceId);
      drafts.append(
        button(
          (source
            ? source.title + ' · ' + fresh.owner.name
            : 'Earlier source · computer ' +
              draft.ref.ownerId.slice(-8) +
              ' · source ' +
              draft.ref.sourceId.slice(-8)) +
            ' · ' +
            (source ? 'Draft saved' : 'Needs context review') +
            ' · ' +
            draft.text.slice(0, 64),
          () => {
            model.openSaved(draft.key);
            render();
            focusContent();
          },
          'saved-draft',
        ),
      );
    }
    draftsNode = drafts;
  }
  if (model.error || model.snapshot?.fixtureError) {
    container.append(
      stateMessage('Inbox unavailable', model.error || model.snapshot.fixtureError, true),
    );
    if (draftsNode) container.append(draftsNode);
    return container;
  }
  if (!model.snapshot || model.snapshot.fixtureLoading)
    return stateMessage(
      'Loading your inbox',
      'Conversation context will appear here when the local snapshot arrives.',
    );
  if (!queue) {
    const entry = button('', showAssistant, 'assistant-entry');
    entry.setAttribute('aria-label', 'Open assistant briefing');
    entry.append(
      element('span', 'Assistant', { class: 'message-speaker' }),
      element('span', localBriefing('What needs me?').text),
      element('span', 'Ask what needs you or what you’re waiting on', { class: 'source-line' }),
    );
    container.append(entry);
  }
  if (!visible.length) {
    container.append(
      stateMessage(
        queue ? 'No tasks here' : 'You’re caught up',
        queue
          ? 'Choose another data source to inspect its queue.'
          : 'No unreviewed updates in this view. Reviewed and snoozed items remain in Queue.',
      ),
    );
    if (draftsNode) container.append(draftsNode);
    return container;
  }
  let previous = null;
  for (const item of visible) {
    const group =
      needs(item) && actionable(item)
        ? 'Waiting on you'
        : actionable(item)
          ? 'Other updates'
          : 'Reviewed, snoozed or done';
    if (group !== previous) {
      container.append(element('h2', group, { class: 'section-label' }));
      previous = group;
    }
    container.append(card(item));
  }
  if (draftsNode) container.append(draftsNode);
  return container;
}
function relationships() {
  const container = element('div');
  container.append(
    heading(
      'Relationships',
      'Project → task → source chats. Waiting owners come from the recorded update.',
    ),
  );
  if (!items().length) {
    container.append(
      stateMessage(
        'No relationships yet',
        'Projects and source chats will appear when the queue has items.',
      ),
    );
    return container;
  }
  const projects = new Map();
  for (const item of items()) {
    const key = JSON.stringify([item.owner.id, item.provenance.project]);
    if (!projects.has(key)) projects.set(key, []);
    projects.get(key).push(item);
  }
  for (const group of projects.values()) {
    const section = element('section', '', { class: 'relation-group' });
    section.append(
      element('h2', group[0].provenance.project),
      element('p', group[0].owner.name + ' · ' + group[0].provenance.channel),
    );
    for (const item of group) {
      const task = element('div', '', { class: 'relation-task' });
      task.append(
        button(item.title, () => open(item)),
        element('small', label(item)),
      );
      for (const source of item.sources)
        task.append(button('↳ ' + source.title, () => open(item, source.id), 'source-link'));
      section.append(task);
    }
    container.append(section);
  }
  return container;
}
function actionAllowed(current) {
  return (
    current &&
    !current.stale &&
    current.item.owner.online &&
    current.item.provenance.mode === 'synthetic' &&
    !current.item.done &&
    !model.storageError &&
    !model.snapshot?.preview.journalError &&
    !model.error
  );
}
function composeAllowed(current) {
  return (
    actionAllowed(current) &&
    !model.replyBlocked() &&
    !current.item.replyUncertain?.includes(current.sourceId)
  );
}
function conversation() {
  const current = model.current();
  if (!current)
    return stateMessage('Choose a conversation', 'Return to the inbox to open its source context.');
  const item = current.item,
    noConversation = item.sources.length === 0,
    source = item.sources.find((s) => s.id === current.sourceId) || {
      title: 'Queued task',
      body: item.summary || 'Waiting for a source conversation.',
    };
  const layout = element('div', '', {
    class: 'conversation-layout',
    'data-selected-owner': item.owner.id,
    'data-selected-source': current.sourceId,
  });
  const top = element('div', '', { class: 'conversation-top' });
  const back = button(
    '‹',
    () => {
      model.back();
      render();
      focusContent();
    },
    'back-button',
  );
  back.setAttribute('aria-label', 'Back to ' + model.returnView);
  const identity = element('div', '', { class: 'conversation-identity' });
  identity.append(
    element('h1', source.title),
    element('span', item.provenance.channel + ' · ' + item.owner.name, { class: 'source-line' }),
  );
  top.append(back, identity);
  layout.append(top);
  const scroll = element('div', '', { class: 'conversation-scroll' });
  {
    const warning = element('div', '', {
      class: 'state-banner',
      role: 'status',
      id: 'recovery-warning',
    });
    warning.append(
      element('span', model.storageError || model.snapshot?.preview.journalError || '', {
        id: 'recovery-warning-copy',
      }),
    );
    warning.append(
      button('Retry local storage', async () => {
        try {
          await request('/api/scenario', { value: 'storage-retry' });
          await load(true);
          model.retryStorage();
          render();
        } catch (error) {
          notice(error.message);
        }
      }),
    );
    warning.hidden = !(model.storageError || model.snapshot?.preview.journalError);
    scroll.append(warning);
  }
  if (current.stale || !item.owner.online || model.error) {
    const banner = element(
      'div',
      current.stale
        ? current.reason
        : model.error || item.provenance.mode === 'read-only'
          ? 'Local Codex context is cached. You can read it and keep writing a draft.'
          : item.owner.name + ' is offline. You can read its context and keep writing a draft.',
      { class: 'state-banner', role: 'status' },
    );
    if (current.stale && !noConversation && model.latest())
      banner.append(
        button('View latest update', () => {
          model.adoptLatest();
          render();
          focusContent();
        }),
      );
    if (model.error) banner.append(button('Reconnect preview', reconnect));
    scroll.append(banner);
  }
  const context = element('section', '', {
    class: 'context-card card',
    'aria-label': 'Selected task and source',
  });
  context.append(
    element('h2', item.title),
    element('p', (item.urgent && actionable(item) ? 'Urgent · ' : '') + label(item)),
  );
  const actions = element('div', '', { class: 'action-row' });
  const reviewed = button('Reviewed', () => act('reviewed'));
  reviewed.id = 'reviewed';
  const snooze = button(item.snoozed ? 'Snoozed 1h' : 'Snooze 1h', () => act('snooze'));
  snooze.id = 'snooze';
  reviewed.disabled =
    !actionAllowed(current) || item.reviewed || model.pending.has(model.selection.key);
  snooze.disabled =
    !actionAllowed(current) || item.snoozed || model.pending.has(model.selection.key);
  actions.append(reviewed, snooze);
  if (!noConversation) context.append(actions);
  scroll.append(context);
  if (item.sources.length > 1) {
    const picker = element('div', '', { class: 'source-picker' });
    picker.append(element('label', 'Source conversation', { for: 'source-picker' }));
    const select = element('select', '', { id: 'source-picker' });
    for (const s of item.sources) select.append(element('option', s.title, { value: s.id }));
    select.value = current.sourceId;
    select.addEventListener('change', () => open(item, select.value));
    picker.append(select);
    scroll.append(picker);
  }
  const messages = element('section', '', {
    class: 'message-list conversation-messages',
    'aria-label': 'Recorded conversation context',
  });
  const original = element('div', '', { class: 'message assistant' });
  original.append(
    element(
      'span',
      noConversation
        ? 'Task context'
        : item.provenance.mode === 'synthetic'
          ? (item.provenance.channel === 'Codex fixture' || model.snapshot?.preview.protocolFixture
              ? source.title
              : item.provenance.sender) + ' · sample'
          : 'Latest recorded source context',
      { class: 'message-speaker' },
    ),
    element('span', source.body || source.summary || item.summary),
  );
  messages.append(original);
  for (const message of source.messages || []) {
    const bubble = element('div', '', {
      class: 'message ' + (message.role === 'user' ? 'user' : 'assistant'),
    });
    bubble.append(
      element(
        'span',
        message.role === 'user' ? 'You · local fixture' : item.owner.name + ' · local fixture',
        { class: 'message-speaker' },
      ),
      element('span', message.text || ''),
    );
    messages.append(bubble);
  }
  scroll.append(messages);
  layout.append(scroll);
  if (noConversation) return layout;
  const composer = element('form', '', {
    class: 'composer',
    'aria-label': 'Reply to selected conversation',
  });
  const row = element('div', '', { class: 'compose-row' });
  const input = element('textarea', '', {
    id: 'reply',
    rows: '2',
    maxlength: '12000',
    'aria-label': 'Reply draft for ' + source.title + ' on ' + item.owner.name,
    placeholder:
      item.provenance.mode === 'synthetic'
        ? 'Reply to this conversation…'
        : 'Draft a reply · read-only preview',
  });
  input.value = model.draft();
  input.addEventListener('input', () => {
    model.draft(input.value);
    updateSend();
  });
  input.addEventListener('compositionstart', () => {
    composing = true;
  });
  input.addEventListener('compositionend', () => {
    composing = false;
  });
  input.addEventListener('keydown', (event) => {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.isComposing &&
      composeAllowed(model.current())
    ) {
      event.preventDefault();
      if (!$('send').disabled) act('reply');
    }
  });
  const send = button('↑', () => act('reply'), 'primary');
  send.id = 'send';
  send.setAttribute('aria-label', 'Send fixture reply');
  row.append(input, send);
  composer.append(row);
  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    act('reply');
  });
  const note = model.storageError
    ? 'Not saved · storage unavailable. This edit is only in memory.'
    : item.done
      ? item.replyUncertain?.includes(current.sourceId)
        ? 'Task done · draft kept; earlier reply acceptance remains unknown.'
        : 'Task done · draft kept; replies disabled.'
      : current.stale
        ? 'Draft saved for this earlier task · review the latest update to act.'
        : !item.owner.online
          ? item.provenance.mode === 'read-only'
            ? 'Cached context · draft saved locally; live messages are disabled.'
            : 'Offline · your draft stays here until the computer reconnects.'
          : item.provenance.mode !== 'synthetic'
            ? 'Read only · local draft recovery; no live messages can be sent.'
            : item.replyUncertain?.includes(current.sourceId)
              ? 'Acceptance unknown · draft retained; retry disabled.'
              : 'Local draft saved · fixture only · Enter sends';
  composer.append(element('p', note, { class: 'composer-note' }));
  const receipt = receipts.get(model.selection.key);
  if (receipt)
    composer.append(
      element('p', receipt.text, {
        class: 'receipt' + (receipt.uncertain ? ' uncertain' : ''),
        role: 'status',
      }),
    );
  layout.append(composer);
  return layout;
}
function updateSend() {
  if ($('assistant-send')) {
    $('assistant-send').disabled = !model.assistantDraft().trim();
    if (model.storageError)
      document.querySelector('.composer-note').textContent =
        'Not saved · this question draft is only in memory.';
    return;
  }
  if (!$('send')) return;
  const current = model.current();
  $('reviewed').disabled =
    !actionAllowed(current) || current.item.reviewed || model.pending.has(model.selection.key);
  $('snooze').disabled =
    !actionAllowed(current) || current.item.snoozed || model.pending.has(model.selection.key);
  $('recovery-warning').hidden = !(model.storageError || model.snapshot?.preview.journalError);
  $('recovery-warning-copy').textContent =
    model.storageError || model.snapshot?.preview.journalError || '';
  if (model.storageError)
    document.querySelector('.composer-note').textContent =
      'Not saved · storage unavailable. This edit is only in memory.';
  $('send').disabled =
    !composeAllowed(model.current()) ||
    !model.draft().trim() ||
    model.pending.has(model.selection.key) ||
    !!model.error;
  $('send').textContent = model.pending.has(model.selection.key) ? '…' : '↑';
  if (model.snapshot?.preview.protocolFixture && model.pending.has(model.selection.key))
    document.querySelector('.composer-note').textContent =
      'Waiting for ' + current.item.owner.name + ' · owner acceptance pending.';
}
function render() {
  if (desktop && nativeExpanded !== model.opened) {
    nativeExpanded = model.opened;
    desktop.setExpanded(model.opened, false).catch((error) => notice(error.message));
  }
  model.persist();
  for (const intent of model.intents.values())
    receipts.set(intent.key, {
      uncertain: !intent.ownerAccepted,
      text: intent.ownerAccepted
        ? intent.action === 'reply'
          ? 'Recovered receipt: the sample owner accepted this reply. No external message was sent.'
          : intent.action === 'reviewed'
            ? 'Review confirmed on the selected sample owner.'
            : 'Snoozed on the selected sample owner. Queued escalation previews are cancelled.'
        : intent.state === 'inFlight'
          ? 'Action recorded locally; waiting for owner acceptance. No resend is enabled.'
          : 'Owner acceptance is unknown. Draft retained; resend disabled.',
    });
  const attention = items().filter((c) => actionable(c) && (needs(c) || c.readyForReview));
  $('dot').dataset.attention = attention.some((c) => needs(c) && c.urgent)
    ? 'urgent'
    : attention.some(needs)
      ? 'needs'
      : 'quiet';
  $('dot-badge').hidden = !attention.length;
  $('dot-badge').textContent = attention.length > 99 ? '99+' : String(attention.length);
  $('dot').setAttribute('aria-expanded', String(model.opened));
  $('dot').setAttribute(
    'aria-label',
    (model.opened ? 'Collapse' : 'Open') +
      ' Work Updates inbox' +
      (attention.length ? ' · ' + attention.length + ' updates' : ' · no new updates'),
  );
  $('shell').hidden = !model.opened;
  document.body.classList.toggle('inbox-open', model.opened);
  document.body.classList.toggle(
    'conversation-open',
    model.opened && ['conversation', 'assistant'].includes(model.view),
  );
  for (const node of $('views').querySelectorAll('button')) {
    if (node.dataset.view === (model.view === 'conversation' ? model.returnView : model.view))
      node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  }
  const value = model.snapshot;
  const protocolMode = value?.preview.protocolFixture === true;
  for (const option of document.querySelectorAll('[data-protocol]')) option.hidden = !protocolMode;
  for (const option of document.querySelectorAll('[data-collector]'))
    option.hidden = !value?.preview.collector;
  if (protocolMode) {
    $('preview-tools').querySelector('p').textContent =
      'Two local protocol fixtures use real loopback pairing and TLS. Owner execution is synthetic; no physical device or external account is connected.';
    for (const [value, text] of [
      ['offline', 'Local protocol fixture B offline'],
      ['reconnect', 'Reconnect local protocol fixture B'],
      ['changed', 'Change protocol fixture B task'],
      ['removed', 'Remove protocol fixture B task'],
      ['done', 'Complete protocol fixture B task'],
      ['duplicate', 'Replay older TLS snapshot'],
      ['forgotten-owner', 'Forget local protocol fixture B'],
    ])
      $('scenario').querySelector('option[value="' + value + '"]').textContent = text;
    for (const value of ['empty', 'loading', 'error', 'long', 'uncertain'])
      $('scenario').querySelector('option[value="' + value + '"]').hidden = true;
  }
  $('connection').textContent =
    model.error ||
    value?.fixtureError ||
    (scope === 'fixtures'
      ? value?.connection || 'Loading sample computers…'
      : value?.preview.liveError ||
        (value?.preview.collector
          ? 'Local Codex current · read only' +
            (value.preview.collector.warnings?.length
              ? ' · history unavailable; recorded events used'
              : '')
          : 'Local Codex snapshot · read only'));
  $('provenance-note').textContent = protocolMode
    ? 'Local TLS protocol fixtures · synthetic owner execution.'
    : scope === 'fixtures'
      ? 'Synthetic conversations · no external accounts connected.'
      : value?.preview.privacyReview
        ? 'Real collector health · private conversation text withheld.'
        : 'Local Codex is read only. Email and DMs remain fixtures.';
  const calls = value?.deliveries.filter((i) => i.kind === 'call') || [];
  $('flow-ledger').textContent = [
    'Live Codex: ' +
      (value?.preview.liveEnabled ? value.preview.liveCount + ' read-only items' : 'not loaded'),
    'Call preview: ' +
      (calls.length
        ? calls.map((i) => i.computers.join(', ') + ' · ' + i.state).join('; ')
        : 'none queued'),
    'Fixture owner commands: ' +
      (value?.preview.commands
        .map(
          (c) =>
            c.method +
            ' → ' +
            (value?.devices.find((device) => device.id === c.ownerId)?.name ||
              'Earlier fixture owner') +
            ' · ' +
            (c.sourceId || c.id),
        )
        .join('; ') || 'none'),
    ...(protocolMode
      ? [
          value.transport.note,
          'Saved action outcomes: ' +
            (value.preview.actionEvents
              .map((event) => event.action + ' · ' + event.state)
              .join('; ') || 'none'),
          'TLS events: ' +
            value.transport.trace
              .map((row) => row.type)
              .slice(-5)
              .join(' · '),
        ]
      : []),
  ].join('\n');
  const current = model.current();
  const key = JSON.stringify(
    [
      model.view,
      scope,
      model.view === 'assistant' ? model.assistant.question : '',
      model.selection?.key,
      current,
      items(),
      model.error,
      value?.fixtureLoading,
      value?.fixtureError,
      [...model.pending],
      [...receipts],
      model.storageError,
      value?.preview.journalError,
    ],
    (key, value) => (key === 'lastSeen' ? undefined : value),
  );
  if (key === bodyKey || composing) {
    updateSend();
    return;
  }
  bodyKey = key;
  const previousFocus = document.activeElement?.id;
  const selectionRange = ['reply', 'assistant-reply'].includes(previousFocus)
    ? [$(previousFocus).selectionStart, $(previousFocus).selectionEnd]
    : null;
  scrollOffsets.set(renderedViewKey, {
    content: $('content').scrollTop,
    conversation: document.querySelector('.conversation-scroll')?.scrollTop || 0,
  });
  renderedViewKey = JSON.stringify([
    scope,
    model.view,
    model.view === 'conversation' ? model.selection?.key : '',
  ]);
  const offset = scrollOffsets.get(renderedViewKey) || { content: 0, conversation: 0 };
  $('content').replaceChildren(
    model.view === 'conversation'
      ? conversation()
      : model.view === 'assistant'
        ? assistantConversation()
        : model.view === 'relationships'
          ? relationships()
          : listView(),
  );
  $('content').scrollTop = offset.content;
  const newScroll = document.querySelector('.conversation-scroll');
  if (newScroll) {
    newScroll.scrollTop =
      scrollReplyKey === model.selection?.key ? newScroll.scrollHeight : offset.conversation;
    scrollReplyKey = '';
  }
  updateSend();
  if (previousFocus && $(previousFocus) && model.opened) {
    $(previousFocus).focus({ preventScroll: true });
    if (selectionRange) $(previousFocus).setSelectionRange(...selectionRange);
  }
}
function notice(text) {
  $('notice').textContent = text;
  $('notice').hidden = false;
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => {
    $('notice').hidden = true;
  }, 4500);
}
async function request(url, input) {
  const response = await fetch(
    url,
    input
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Dot-Preview': 'fixture' },
          body: JSON.stringify(input),
        }
      : { cache: 'no-store' },
  );
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'The local preview is unavailable.');
  return value;
}
async function load(reconnect = false) {
  if (fetching) return;
  fetching = true;
  try {
    model.update(await request('/api/state'), { reconnect });
  } catch (error) {
    model.error = error.message;
  } finally {
    fetching = false;
    render();
  }
}
async function reconnect() {
  try {
    await request('/api/scenario', { value: 'reconnect' });
    await load(true);
  } catch (error) {
    model.error = error.message;
    render();
  }
}
async function act(action) {
  let token;
  try {
    if (!(action === 'reply' ? composeAllowed(model.current()) : actionAllowed(model.current())))
      return;
    token = model.token();
    if (model.pending.has(token.key) || (action === 'reply' && !token.text.trim())) return;
    const intent = model.begin(token, action, crypto.randomUUID());
    render();
    const result = await request('/api/action', intent);
    model.update(result.snapshot);
    model.finish(token, action === 'reply' && result.result.ownerAccepted);
    if (
      action === 'reply' &&
      result.result.ownerAccepted &&
      model.selection?.key === token.key &&
      model.view === 'conversation'
    )
      scrollReplyKey = token.key;
    const owner =
      model.snapshot.cards.find((c) => c.id === token.id && c.owner.id === token.ownerId)?.owner
        .name || 'Selected owner';
    receipts.set(token.key, {
      uncertain: !result.result.ownerAccepted,
      text: result.result.ownerAccepted
        ? action === 'reply'
          ? 'Local fixture received the reply. ' +
            owner +
            ' accepted it. No external message was sent.'
          : action === 'reviewed'
            ? 'Reviewed on ' + owner + '. The task stays open.'
            : 'Snoozed on ' + owner + '. Obsolete queued escalation previews are cancelled.'
        : 'Local fixture received the reply. Owner acceptance is unknown. Your draft is retained; retry is disabled.',
    });
  } catch (error) {
    if (token) {
      model.finish(token, false);
      const intent = [...model.intents.values()].find(
        (i) => i.key === token.key && i.state === 'inFlight',
      );
      if (intent) intent.state = 'uncertain';
    }
    notice(error.message);
  }
  render();
}
$('dot').addEventListener('click', () => {
  model.toggle();
  render();
  if (desktop && model.opened)
    desktop.setExpanded(true, true).catch((error) => notice(error.message));
  if (model.opened) focusContent();
});
$('hide').addEventListener('click', () => {
  model.close();
  render();
  $('dot').focus();
});
$('views').addEventListener('click', (event) => {
  if (event.target.dataset.view) {
    model.navigate(event.target.dataset.view);
    render();
    focusContent();
  }
});
$('views').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const buttons = [...$('views').querySelectorAll('button')];
  const i = buttons.indexOf(document.activeElement);
  buttons[(i + (event.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length].focus();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !model.opened) return;
  if (model.view === 'conversation') {
    model.back();
    render();
    focusContent();
  } else {
    model.close();
    render();
    $('dot').focus();
  }
});
$('data-source').addEventListener('change', () => {
  scope = $('data-source').value;
  model.navigate('inbox');
  render();
});
$('apply-scenario').addEventListener('click', async () => {
  try {
    const response = await request('/api/scenario', { value: $('scenario').value });
    model.update(response.snapshot);
    render();
    if ($('scenario').value === 'duplicate')
      notice(
        response.duplicateRejected
          ? 'Older duplicate update rejected.'
          : 'Duplicate update was accepted unexpectedly.',
      );
  } catch (error) {
    notice(error.message);
  }
});
$('advance-clock').addEventListener('click', async () => {
  try {
    model.update((await request('/api/scenario', { value: 'advance' })).snapshot);
    render();
  } catch (error) {
    notice(error.message);
  }
});
$('export-recovery').addEventListener('click', () => {
  $('recovery-export').value = JSON.stringify(model.export());
  $('recovery-export').hidden = false;
  notice('Local draft and routing recovery copy is ready. Incoming source logs are excluded.');
});
async function start() {
  if (desktop) {
    document.body.classList.add('desktop-review');
    await desktop.bootstrap();
    // Keep the exact conversation and drafts, but never expand or focus at startup.
    model.close();
    desktop.onCollapse(() => {
      model.close();
      render();
    });
    desktop.onTools(() => {
      if (!model.opened) {
        model.opened = true;
        model.navigate('inbox');
        render();
      }
      document.body.classList.toggle('review-tools');
    });
  }
  await load();
  setInterval(() => load(), 2500);
}
start().catch((error) => notice(error.message));
