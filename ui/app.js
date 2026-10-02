'use strict';
const api = window.workUpdates;
const APP_ICON =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="116" fill="#5c7a6a"/><path fill="#f1f4f7" d="M96 136H150L185 296L229 155H283L325 296L361 136H416L359 376H304L257 221L207 376H152Z"/></svg>',
  );
async function call(method, data) {
  const result = await api[method](data);
  if (!result.ok) throw Object.assign(new Error(result.error), { taskId: result.taskId });
  return result.value;
}
const $ = (id) => document.getElementById(id);
function presentWindow(value) {
  const visible = value.windowMode !== 'hidden';
  document.documentElement.classList.toggle('revealed', visible);
  document.body.inert = !visible;
}
function node(tag, text = '', attributes = {}) {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}
function button(label, action, style = '') {
  const element = node('button', label, { type: 'button' });
  element.className = style;
  element.addEventListener('click', action);
  return element;
}
function notice(value, error = false) {
  const box = $('notice');
  if (!box) return;
  box.textContent = value;
  box.hidden = false;
  box.classList.toggle('error-text', error);
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => (box.hidden = true), 4200);
}
function ago(at) {
  const age = Math.max(0, Math.floor(Date.now() / 1000) - at);
  return age < 60
    ? 'just now'
    : age < 3600
      ? Math.floor(age / 60) + 'm ago'
      : age < 86400
        ? Math.floor(age / 3600) + 'h ago'
        : Math.floor(age / 86400) + 'd ago';
}
function clock() {
  const date = new Date();
  $('date').textContent = date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
  $('clock').textContent = date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
if ($('corner-toggle')) {
  $('corner-toggle').replaceChildren(node('img', '', { src: APP_ICON, alt: '' }));
  $('corner-toggle').addEventListener('click', () => call('window', { action: 'corner' }));
  $('corner-toggle').addEventListener('contextmenu', (event) => {
    event.preventDefault();
    call('window', { action: 'new' });
  });
  api.subscribe((value) => {
    $('corner-toggle').setAttribute(
      'aria-label',
      value.windowMode === 'peek'
        ? 'Keep Work Updates open'
        : value.windowMode === 'pinned'
          ? 'Hide Work Updates queue'
          : 'Show Work Updates queue',
    );
    document.body.classList.toggle('latched', value.windowMode === 'pinned');
  });
} else {
  document.addEventListener('pointerdown', () =>
    call('window', { action: 'retain' }).catch(() => {}),
  );
  let state,
    view = 'updates',
    showAll = false,
    mode = null,
    selected = null,
    selectedTaskKey = null,
    selectedSourceId = null,
    selectedCardSnapshot = null,
    returnFocus = null,
    renderedQueueKey = null,
    pressed = false,
    swipeId = null;
  let taskDraft = { title: '', prompt: '', cwd: '' },
    messageDrafts = new Map(),
    answerDrafts = new Map(),
    lastMessages = '',
    lastRequests = '',
    lastActions = '',
    lastContext = '',
    showHidden = false,
    browseAll = false;
  const pendingSends = new Set();
  const selectedSource = (card = currentCard()) =>
    card?.sources.find((s) => s.id === selectedSourceId);
  const currentCard = () =>
    (selectedCardSnapshot?.id === selected && pendingSends.has(selectedSourceId || selected)
      ? selectedCardSnapshot
      : null) ||
    state?.done.find((c) => c.taskKey === selected) ||
    state?.cards.find((c) => c.id === selected);
  function bindPress(element, click, hold, swipe) {
    let timer,
      held = false,
      moved = false,
      origin;
    const stop = () => {
      clearTimeout(timer);
      element.classList.remove('pressing');
      pressed = false;
    };
    element.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      held = false;
      moved = false;
      pressed = true;
      origin = [event.clientX, event.clientY];
      element.focus({ preventScroll: true });
      element.classList.add('pressing');
      if (swipe) element.setPointerCapture(event.pointerId);
      timer = setTimeout(() => {
        held = true;
        stop();
        hold();
      }, 650);
    });
    element.addEventListener('pointermove', (event) => {
      if (pressed && Math.hypot(event.clientX - origin[0], event.clientY - origin[1]) > 10) {
        moved = true;
        stop();
      }
    });
    element.addEventListener('pointercancel', () => {
      moved = true;
      stop();
    });
    element.addEventListener('pointerleave', () => {
      if (pressed) {
        moved = true;
        stop();
      }
    });
    element.addEventListener('pointerup', (event) => {
      if (swipe && moved && !held && origin) {
        const dx = event.clientX - origin[0],
          dy = event.clientY - origin[1];
        if (Math.abs(dy) < 35 && Math.abs(dx) > 70) swipe(dx);
      }
      stop();
      setTimeout(() => {
        if (!mode) render();
      }, 0);
    });
    element.addEventListener('click', (event) => {
      if (held || moved) {
        event.preventDefault();
        held = false;
        moved = false;
        return;
      }
      click();
    });
    element.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      stop();
      hold();
    });
    element.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        held = false;
        moved = false;
      }
      if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
        event.preventDefault();
        stop();
        hold();
      }
    });
  }
  function render() {
    if (!state || mode || pressed) return;
    $('demo-label').hidden = !state.demo;
    $('counts').textContent =
      view === 'updates' ? state.ready + ' ready · ' + state.working + ' working' : '';
    const heading =
      view === 'done' ? 'Finished tasks' : view === 'queued' ? 'Queued tasks' : 'From your chats';
    if ($('view-menu').firstElementChild?.textContent !== heading)
      $('view-menu').replaceChildren(
        node('span', heading),
        node('span', '⌄', { class: 'chevron' }),
      );
    let cards =
      view === 'done'
        ? state.done
        : state.cards.filter(
            (c) => !c.done && (view === 'queued' ? c.status === 'queued' : c.status !== 'queued'),
          );
    if (view !== 'done') {
      cards = cards.filter((c) =>
        showHidden ? c.reviewed || c.snoozed : !c.reviewed && !c.snoozed,
      );
      if (!browseAll && view === 'updates' && !showHidden)
        cards = cards.filter((c) => c.kind === 'local' || c.at >= (state.settings.queueSince || 0));
    }
    const visibleCards = showAll ? cards : cards.slice(0, 3);
    const queueKey = JSON.stringify([
      view,
      showHidden,
      swipeId,
      visibleCards.map((card) => [
        view === 'done' ? card.taskKey : card.id,
        card.title,
        card.label,
        card.status,
        card.waitingOn?.kind === 'you',
        card.urgent,
        card.sources.length,
        ago(card.doneAt || card.at),
      ]),
    ]);
    // Window mode and watcher heartbeats don't change the cards. Keep their
    // decoded images and composited blur layers intact when a hover reveals us.
    if (queueKey !== renderedQueueKey) {
      const queue = $('queue'),
        offset = queue.scrollTop,
        focused = document.activeElement?.dataset.id;
      const content = document.createDocumentFragment();
      for (const card of visibleCards) {
        const id = view === 'done' ? card.taskKey : card.id;
        const wrap = node('div');
        wrap.className = 'card-wrap' + (card.sources.length > 1 ? ' grouped' : '');
        wrap.classList.toggle('swiped', swipeId === id);
        const surface = node('div');
        surface.className = 'card';
        wrap.append(surface);
        const replacement = node('button', '', { type: 'button' });
        replacement.className = 'card-trigger';
        replacement.dataset.id = id;
        bindPress(
          replacement,
          () => showCard(id, true, card.taskKey),
          () => showCard(id, true, card.taskKey),
          view !== 'done' && card.status !== 'queued'
            ? (dx) => {
                swipeId = dx < 0 ? id : null;
                wrap.classList.toggle('swiped', swipeId === id);
                surface.querySelector('.swipe-actions').inert = swipeId !== id;
              }
            : null,
        );
        replacement.setAttribute('aria-label', card.title + ', ' + card.label);
        const header = node('span', '', { class: 'card-header' });
        const icon = node('img', '', { src: APP_ICON, alt: '', 'aria-hidden': 'true' });
        icon.className = 'app-icon';
        header.append(icon);
        const copy = node('span');
        copy.className = 'card-copy';
        const meta = node('span');
        meta.className = 'meta';
        meta.textContent =
          'Work Updates' + (card.sources.length > 1 ? ' · ' + card.sources.length + ' chats' : '');
        const title = node('span', card.title, { class: 'card-title' });
        const line = node('span', '', { class: 'notification-line' });
        line.append(meta, node('span', ago(card.doneAt || card.at), { class: 'card-age' }));
        copy.append(line, title);
        const statuses = node('span', '', { class: 'card-statuses' });
        const badge = node('span', card.label, { class: 'badge ' + card.status });
        if (card.waitingOn?.kind === 'you') badge.classList.add('needs');
        statuses.append(badge);
        if (card.urgent) statuses.append(node('span', ' · Urgent', { class: 'badge urgent' }));
        copy.append(statuses);
        header.append(copy);
        replacement.append(header);
        surface.append(replacement);
        if (view !== 'done' && card.status !== 'queued') {
          const tray = node('div', '', { class: 'swipe-actions' });
          tray.inert = swipeId !== id;
          const dismiss = button(showHidden ? 'Restore' : 'Reviewed', () =>
            runAction(card.id, showHidden ? 'restore' : 'reviewed'),
          );
          dismiss.setAttribute(
            'aria-label',
            showHidden ? 'Restore notification' : 'Mark update reviewed',
          );
          tray.append(
            button('Snooze 1h', () => runAction(card.id, 'snooze')),
            dismiss,
          );
          surface.prepend(tray);
        }
        content.append(wrap);
      }
      if (!cards.length) {
        const empty = node('div');
        empty.className = 'empty';
        empty.append(
          node(
            'h2',
            view === 'done'
              ? 'A place for finished tasks'
              : view === 'queued'
                ? 'Room for your next task'
                : showHidden
                  ? 'Nothing hidden'
                  : 'A little breathing room',
          ),
          node(
            'p',
            view === 'done'
              ? 'Tasks you mark Done stay here until you reopen them.'
              : view === 'queued'
                ? 'Add a task now. It will wait here until you start its chat.'
                : showHidden
                  ? 'Snoozed and reviewed updates appear here.'
                  : 'New completions and tasks that need you will show up here.',
          ),
        );
        if (view === 'queued') empty.append(button('＋ New task', () => showComposer(), 'primary'));
        content.append(empty);
      }
      queue.replaceChildren(content);
      renderedQueueKey = queueKey;
      queue.scrollTop = offset;
      if (focused)
        queue
          .querySelector('[data-id="' + CSS.escape(focused) + '"]')
          ?.focus({ preventScroll: true });
    }
    $('show-all').hidden = cards.length <= 3;
    $('show-all').textContent = showAll
      ? 'Show fewer'
      : 'Show all ' + cards.length + (view === 'done' ? ' completed tasks' : ' updates');
    $('undo').hidden = !state.undo;
    $('connection').textContent =
      state.remote && !state.connected
        ? state.connection
        : !state.health.ok
          ? 'Sync paused · ' + state.health.message
          : state.remote
            ? state.connection
            : state.collectedAt
              ? 'Watching ' + state.monitoredCount + ' local chats · Up to date'
              : 'Reading local Codex chats…';
  }
  function openPanel(next, title) {
    if (!mode) returnFocus = document.activeElement;
    mode = next;
    $('panel').className = next === 'details' || next === 'actions' ? 'notification-panel' : '';
    $('panel').replaceChildren();
    $('panel').setAttribute('aria-label', title);
    $('scrim').hidden = false;
    document.body.classList.add('panel-open');
    $('shell').inert = true;
    const top = node('div');
    top.className = 'panel-top';
    const meta = node('span', title);
    meta.id = 'panel-status';
    top.append(meta, button('×', closePanel, 'icon'));
    top.lastChild.setAttribute('aria-label', 'Back to queue');
    $('panel').append(top);
    queueMicrotask(() => top.lastChild.focus());
    return $('panel');
  }
  function closePanel() {
    if (mode === 'composer') {
      taskDraft.title = $('task-title').value;
      taskDraft.prompt = $('task-prompt').value;
    }
    const before = returnFocus;
    mode = null;
    selected = null;
    selectedTaskKey = null;
    selectedSourceId = null;
    selectedCardSnapshot = null;
    swipeId = null;
    $('scrim').hidden = true;
    document.body.classList.remove('panel-open');
    $('shell').inert = false;
    render();
    if (before?.isConnected) before.focus();
    else if (before?.dataset.id)
      document.querySelector('[data-id="' + CSS.escape(before.dataset.id) + '"]')?.focus();
    else $('new-task').focus();
  }
  async function runAction(id, action) {
    try {
      const next = await call('action', {
        id,
        action,
        taskKey: mode === 'details' ? selectedTaskKey : undefined,
      });
      state = { ...state, ...next, settings: state.settings };
      swipeId = null;
      if (mode) closePanel();
      else render();
      notice(
        action === 'done'
          ? 'Marked done · Undo is available'
          : action === 'snooze'
            ? 'Snoozed for 1h'
            : action === 'reopen'
              ? 'Task reopened'
              : action === 'restore'
                ? 'Update restored'
                : 'Reviewed · Undo is available',
      );
    } catch (error) {
      notice(error.message, true);
    }
  }
  async function startTask(id) {
    try {
      showCard(id, true);
      await call('start', { id });
      notice('Chat started');
    } catch (error) {
      notice(error.message, true);
      updateDetails();
    }
  }
  function sourceSelect(card) {
    if (card.sources.length <= 1) return null;
    const select = node('select', '', { 'aria-label': 'Source chat' });
    select.id = 'source-chat';
    for (const source of card.sources)
      select.append(node('option', source.title, { value: source.id }));
    select.value = selectedSourceId;
    select.addEventListener('change', () => {
      const input = $('chat-input');
      if (input) messageDrafts.set(selected + ':' + selectedSourceId, input.value);
      selectedSourceId = select.value;
      if (input) input.value = messageDrafts.get(selected + ':' + selectedSourceId) || '';
      lastContext = '';
      updateDetails();
    });
    return select;
  }
  function primaryActions(card, host) {
    host.replaceChildren();
    const actions = node('div');
    actions.className = 'actions';
    if (card.done) {
      const same = state.cards.some((c) => c.taskKey === card.taskKey);
      actions.append(
        button(
          same ? 'Reopen task' : 'Reopen as new task',
          () => runAction(card.taskKey, 'reopen'),
          'primary',
        ),
      );
      if (card.sources.length)
        actions.append(
          button(
            state.remote ? 'View chat' : 'Open chat ↗',
            () => (state.remote ? showCard(card.taskKey, true) : openSource(card)),
            'quiet',
          ),
        );
    } else {
      if (card.status === 'queued' || (card.kind === 'local' && card.status === 'blocked'))
        actions.append(
          button(
            card.threadId ? 'Retry in this chat' : 'Start chat',
            () => startTask(card.id),
            'primary',
          ),
        );
      else if (card.sources.length)
        actions.append(
          button(
            state.remote ? 'Chat here' : 'Open chat ↗',
            () => (state.remote ? showCard(card.id, true) : openSource(card)),
            'primary',
          ),
        );
      const secondary = node('div');
      secondary.className = 'secondary-row';
      if (card.status !== 'queued')
        secondary.append(button('Reviewed', () => runAction(card.id, 'reviewed')));
      secondary.append(button('Snooze 1h', () => runAction(card.id, 'snooze')));
      actions.append(secondary);
      if (card.kind === 'local' && ['working', 'needs'].includes(card.status))
        actions.append(
          button(
            'Stop current pass',
            async () => {
              try {
                await call('stop', { id: card.id });
                notice('Stopping this pass');
              } catch (error) {
                notice(error.message, true);
              }
            },
            'quiet',
          ),
        );
    }
    host.append(actions);
  }
  async function openSource(card) {
    try {
      await call('open', {
        id: card.done ? card.taskKey : card.id,
        taskKey: selectedTaskKey,
        sourceId: selectedSourceId,
      });
      closePanel();
    } catch (error) {
      notice(error.message, true);
    }
  }
  function showCard(id, details, expectedTaskKey) {
    const origin = document
      .querySelector('[data-id="' + CSS.escape(id) + '"]')
      ?.getBoundingClientRect();
    const card = state?.done.find((c) => c.taskKey === id) || state?.cards.find((c) => c.id === id);
    if (!card) return;
    if (expectedTaskKey && card.taskKey !== expectedTaskKey) {
      notice('This task changed. Open its latest update.');
      render();
      return;
    }
    selectedCardSnapshot = card;
    selected = id;
    selectedTaskKey = card.taskKey;
    selectedSourceId = card.primarySourceId || card.sources[0]?.id || null;
    openPanel(details ? 'details' : 'actions', card.label + ' · ' + ago(card.at));
    selected = id;
    const panel = $('panel');
    const title = node('h2', card.title);
    title.className = 'panel-title';
    panel.append(title);
    const picker = sourceSelect(card);
    if (picker) panel.append(picker);
    if (details) {
      const approvals = node('div');
      approvals.id = 'approval-host';
      panel.append(approvals);
      const context = node('div');
      context.id = 'context-host';
      panel.append(context);
      const messages = node('div');
      messages.className = 'message-list';
      messages.id = 'messages';
      panel.append(messages);
      if (!card.done) {
        const row = node('form');
        row.className = 'compose-row';
        const input = node('textarea', '', {
          id: 'chat-input',
          placeholder: card.status === 'queued' ? 'Start this task to chat…' : 'Message this chat…',
          'aria-label': 'Chat message',
          rows: '2',
        });
        input.value = messageDrafts.get(id + ':' + selectedSourceId) || '';
        input.addEventListener('input', () => {
          messageDrafts.set(id + ':' + selectedSourceId, input.value);
          updateSendState();
        });
        const send = button('Send', () => row.requestSubmit(), 'primary');
        send.id = 'send-message';
        row.append(input, send);
        row.addEventListener('submit', async (event) => {
          event.preventDefault();
          const text = input.value;
          if (!text.trim()) return;
          const requestId = selected,
            taskKey = selectedTaskKey,
            sourceId = selectedSourceId;
          if (pendingSends.has(sourceId || requestId)) return;
          pendingSends.add(sourceId || requestId);
          send.disabled = true;
          try {
            const result = await call('send', {
              id: requestId,
              taskKey,
              text,
              sourceId,
            });
            messageDrafts.delete(requestId + ':' + sourceId);
            input.value = '';
            if (result?.taskId && result.taskId !== requestId) state = await call('state');
            if (
              mode === 'details' &&
              selected === requestId &&
              result?.taskId &&
              result.taskId !== requestId
            )
              showCard(result.taskId, true);
          } catch (error) {
            if (error.taskId && mode === 'details' && selected === requestId) {
              state = await call('state');
              messageDrafts.set(error.taskId + ':' + sourceId, text);
              if (mode === 'details' && selected === requestId) showCard(error.taskId, true);
            }
            notice(error.message, true);
          } finally {
            pendingSends.delete(sourceId || requestId);
            updateSendState();
          }
        });
        input.addEventListener('keydown', (event) => {
          if (
            event.key === 'Enter' &&
            !event.isComposing &&
            event.keyCode !== 229 &&
            (!event.shiftKey || event.ctrlKey || event.metaKey)
          ) {
            event.preventDefault();
            if (!send.disabled) row.requestSubmit();
          }
        });
        panel.append(row);
        panel.append(
          node('p', 'Enter to send · Shift+Enter for a new line', {
            class: 'field-note chat-keyboard-hint',
          }),
        );
      }
      const error = node('div');
      error.id = 'task-error';
      error.className = 'error-text';
      panel.append(error);
    }
    const actions = node('div');
    actions.id = 'primary-actions';
    panel.append(actions);
    primaryActions(card, actions);
    if (details && card.kind === 'observed' && !card.done) {
      const status = node('select', '', { 'aria-label': 'Your status' });
      status.id = 'manual-status';
      for (const [value, label] of [
        ['auto', 'Automatic'],
        ['needs', 'Waiting on you'],
        ['waiting', 'Waiting · set who below'],
        ['blocked', 'Blocked'],
        ['working', 'Working'],
      ])
        status.append(node('option', label, { value }));
      status.value = card.manual || 'auto';
      status.addEventListener('change', async () => {
        try {
          const next = await call('action', { id: card.id, action: 'status:' + status.value });
          state = { ...state, ...next, settings: state.settings };
          updateDetails();
          notice('Status updated · Undo is available');
        } catch (error) {
          notice(error.message, true);
        }
      });
      panel.append(
        node('label', 'Your status', { class: 'field-label', for: 'manual-status' }),
        status,
      );
      const ownerRow = node('form', '', { class: 'compose-row' });
      const owner = node('input', '', {
        id: 'waiting-owner',
        placeholder: 'Person or team',
        'aria-label': 'Who are you waiting on?',
        maxlength: '80',
      });
      owner.value = card.waitingOn?.kind === 'other' ? card.waitingOn.name : '';
      const ownerSave = button('Set', () => {}, '');
      ownerSave.type = 'submit';
      ownerRow.append(owner, ownerSave);
      ownerRow.addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
          const next = await call('action', { id: card.id, action: 'owner:' + owner.value.trim() });
          state = { ...state, ...next, settings: state.settings };
          status.value = 'waiting';
          updateDetails();
          notice('Waiting owner saved · Undo is available');
        } catch (error) {
          notice(error.message, true);
        }
      });
      panel.append(
        node('label', 'Waiting on someone else?', { class: 'field-label', for: 'waiting-owner' }),
        ownerRow,
      );
      const group = state.groups?.find((g) => g.id === card.id);
      if (group)
        panel.append(button('Edit chat group', () => groupEditor(group.id), 'detail-link'));
    }
    if (details && !card.done) {
      const priority = node('select', '', { id: 'task-priority', 'aria-label': 'Priority' });
      for (const [value, label] of [
        ['auto', 'Automatic'],
        ['urgent', 'Urgent'],
        ['normal', 'Normal'],
      ])
        priority.append(node('option', label, { value }));
      priority.value = card.priority || 'auto';
      priority.addEventListener('change', async () => {
        try {
          const next = await call('action', { id: card.id, action: 'priority:' + priority.value });
          state = { ...state, ...next, settings: state.settings };
          updateDetails();
          notice('Priority updated · Undo is available');
        } catch (error) {
          notice(error.message, true);
        }
      });
      panel.append(
        node('label', 'Priority', { class: 'field-label', for: 'task-priority' }),
        priority,
        node('p', 'Waiting on you stays first, followed by urgent tasks.', { class: 'field-note' }),
      );
      const complete = button('Complete task', () => runAction(id, 'done'), 'detail-link');
      complete.id = 'complete-task';
      panel.append(complete);
    }
    if (!details) panel.append(button('Details & chat', () => showCard(id, true), 'detail-link'));
    const preview = node('section', '', { class: 'notification-preview' });
    const top = panel.querySelector('.panel-top');
    const status = $('panel-status');
    status.className = 'expanded-status';
    status.textContent = card.label + (card.urgent ? ' · Urgent' : '');
    const close = top.lastElementChild;
    top.replaceChildren(
      node('img', '', { src: APP_ICON, alt: '', class: 'app-icon' }),
      node('span', 'Work Updates', { class: 'notification-app' }),
      node('span', ago(card.doneAt || card.at), { id: 'notification-age', class: 'card-age' }),
      close,
    );
    preview.append(top, title, status);
    for (const child of [...panel.children]) {
      if (child === actions || child === preview || child.classList.contains('detail-link'))
        continue;
      // Context, reply and approvals belong to the expanded notification.
      if (
        child === picker ||
        ['approval-host', 'context-host', 'messages', 'task-error'].includes(child.id) ||
        (child.classList.contains('compose-row') && child.querySelector('#chat-input')) ||
        child.classList.contains('chat-keyboard-hint')
      )
        preview.append(child);
    }
    panel.prepend(preview);
    if (details && !card.done) {
      const settings = node('details', '', { class: 'task-options' });
      settings.append(node('summary', 'Task settings'));
      for (const child of [...panel.children])
        if (child !== preview && child !== actions) settings.append(child);
      panel.append(settings);
    }
    if (origin && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const target = preview.getBoundingClientRect();
      preview.animate(
        [
          {
            transform: `translate(${origin.x - target.x}px, ${origin.y - target.y}px) scale(${origin.width / target.width}, ${origin.height / target.height})`,
            opacity: 0.65,
          },
          { transform: 'none', opacity: 1 },
        ],
        { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' },
      );
    }
    if (details) {
      lastMessages = '';
      lastRequests = '';
      lastActions = '';
      lastContext = '';
      updateDetails();
      if (!card.done) call('details', { id }).catch((error) => notice(error.message, true));
    }
  }
  function updateSendState() {
    const card = currentCard(),
      input = $('chat-input'),
      send = $('send-message');
    if (!card || !input) return;
    const source = selectedSource(card);
    const unavailable =
      (state.remote && !state.connected) ||
      card.done ||
      !card.sources.length ||
      pendingSends.has(selectedSourceId || selected) ||
      (card.kind === 'observed' && source?.lifecycle === 'working') ||
      state.approvals.some((r) => r.taskId === card.id);
    input.disabled = unavailable;
    send.disabled = unavailable || !input.value.trim();
    input.placeholder =
      card.status === 'queued'
        ? 'Start this task to chat…'
        : unavailable
          ? 'Open Codex or answer the request above…'
          : 'Message this chat…';
  }
  function updateDetails() {
    if (mode !== 'details') return;
    const card = currentCard();
    if (!card) return;
    if (card.taskKey !== selectedTaskKey || (selectedSourceId && !selectedSource(card))) {
      closePanel();
      notice('This task changed. Open its latest update.');
      return;
    }
    const source = selectedSource(card);
    $('panel').querySelector('.panel-title').textContent = source?.taskTitle || card.title;
    $('panel-status').textContent = card.label + (card.urgent ? ' · Urgent' : '');
    $('notification-age').textContent = ago(card.doneAt || card.at);
    if ($('task-error')) $('task-error').textContent = card.error || '';
    const complete = $('complete-task');
    if (complete) {
      complete.disabled = ['working', 'starting', 'needs'].includes(card.status);
      complete.title = complete.disabled
        ? 'Finish or stop the current pass first'
        : 'Finish the task and move it to Done';
    }
    const list = $('messages'),
      messages = card.messages || [],
      signature = JSON.stringify(messages);
    if (signature !== lastMessages) {
      const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40,
        offset = list.scrollTop;
      list.replaceChildren();
      for (const message of messages) {
        const item = node('div', message.text);
        item.className = 'message ' + message.role;
        list.append(item);
      }
      list.scrollTop = nearBottom ? list.scrollHeight : offset;
      lastMessages = signature;
    }
    const context = $('context-host'),
      contextSignature = JSON.stringify(
        source && [source.id, source.title, source.body, source.contextLoaded],
      );
    if (card.kind === 'observed' && contextSignature !== lastContext) {
      const offsets = [...context.querySelectorAll('.body-text')].map((e) => e.scrollTop);
      context.replaceChildren(node('div', 'Latest recorded update', { class: 'eyebrow' }));
      for (const source of card.sources.filter((s) => s.id === selectedSourceId)) {
        context.append(
          node('div', 'Chat · ' + source.title, { class: 'source-name' }),
          node(
            'div',
            source.body ||
              (source.contextLoaded ? 'No recorded message yet.' : 'Loading this chat’s context…'),
            { class: 'body-text' },
          ),
        );
      }
      context.querySelectorAll('.body-text').forEach((e, i) => (e.scrollTop = offsets[i] || 0));
      lastContext = contextSignature;
    } else if (!context.childNodes.length) {
      context.append(node('div', 'Chat · ' + card.title, { class: 'source-name' }));
    }
    const requests = state.approvals.filter((r) => r.taskId === card.id),
      requestSignature = JSON.stringify(requests);
    if (requestSignature !== lastRequests) {
      const host = $('approval-host');
      host.replaceChildren();
      for (const request of requests) {
        const box = node('div');
        box.className = 'approval';
        box.append(
          node('h3', request.kind === 'question' ? 'Your answer is needed' : 'Permission needed'),
        );
        if (request.reason) box.append(node('p', request.reason));
        if (request.command) box.append(node('pre', request.command));
        if (request.grantRoot) box.append(node('pre', 'File changes in ' + request.grantRoot));
        if (request.kind === 'permissions')
          box.append(node('pre', JSON.stringify(request.permissions, null, 2)));
        if (request.kind === 'question') {
          const fields = new Map();
          for (const question of request.questions) {
            box.append(
              node('label', question.question, {
                class: 'field-label',
                for: 'answer-' + question.id,
              }),
            );
            if (question.options?.length)
              box.append(
                node(
                  'p',
                  question.options
                    .map((o) => o.label + (o.description ? ' — ' + o.description : ''))
                    .join('\n'),
                ),
              );
            const key = request.id + ':' + question.id,
              answer = node('input', '', { id: 'answer-' + question.id });
            answer.value = answerDrafts.get(key) || '';
            answer.addEventListener('input', () => answerDrafts.set(key, answer.value));
            box.append(answer);
            fields.set(question.id, answer);
          }
          box.append(
            button(
              'Send answer',
              async () => {
                try {
                  await call('respond', {
                    id: request.id,
                    answers: Object.fromEntries([...fields].map(([id, e]) => [id, e.value])),
                  });
                  for (const id of fields.keys()) answerDrafts.delete(request.id + ':' + id);
                } catch (error) {
                  notice(error.message, true);
                }
              },
              'primary',
            ),
          );
        } else {
          const row = node('div');
          row.className = 'secondary-row';
          row.append(
            button('Allow once', () => respond(request.id, 'accept'), 'primary'),
            button('Deny', () => respond(request.id, 'decline')),
          );
          box.append(row);
        }
        host.append(box);
      }
      lastRequests = requestSignature;
    }
    const actionSignature = JSON.stringify([
      card.status,
      card.done,
      card.threadId,
      state.remote,
      state.connected,
    ]);
    if (actionSignature !== lastActions) {
      primaryActions(card, $('primary-actions'));
      lastActions = actionSignature;
    }
    updateSendState();
  }
  async function respond(id, decision) {
    try {
      await call('respond', { id, decision });
    } catch (error) {
      notice(error.message, true);
    }
  }
  function showComposer(advanced = false) {
    openPanel('composer', 'New task');
    selected = null;
    const panel = $('panel');
    panel.append(node('h2', 'What needs doing?', { class: 'panel-title' }));
    const form = node('form'),
      title = node('input', '', {
        id: 'task-title',
        placeholder: 'A short task title',
        maxlength: '100',
      }),
      prompt = node('textarea', '', {
        id: 'task-prompt',
        placeholder: 'Tell Codex what you want it to do…',
        maxlength: '12000',
      });
    title.value = taskDraft.title;
    prompt.value = taskDraft.prompt;
    form.append(
      node('label', 'Task title', { class: 'field-label', for: 'task-title' }),
      title,
      node('label', 'Prompt', { class: 'field-label', for: 'task-prompt' }),
      prompt,
    );
    const workspace = node('div');
    workspace.className = 'workspace';
    const workspaceText = node('span', taskDraft.cwd || 'Dedicated task folder');
    workspaceText.className = 'workspace-text';
    if (state.remote) {
      const folders = node('select', '', { 'aria-label': 'Desktop workspace' });
      folders.append(node('option', 'Dedicated task folder', { value: '' }));
      for (const folder of state.settings.projects || [])
        folders.append(node('option', folder, { value: folder }));
      folders.value = taskDraft.cwd;
      folders.addEventListener('change', () => (taskDraft.cwd = folders.value));
      workspace.append(folders);
    } else
      workspace.append(
        workspaceText,
        button('Choose folder…', async () => {
          try {
            const chosen = await call('project');
            if (chosen.cwd) {
              taskDraft.cwd = chosen.cwd;
              workspaceText.textContent = chosen.cwd;
            }
          } catch (error) {
            notice(error.message, true);
          }
        }),
      );
    form.append(
      node('label', 'Workspace', { class: 'field-label' }),
      workspace,
      node(
        'p',
        'File changes stay inside this workspace. Codex asks before actions that need approval.',
        { class: 'field-note' },
      ),
    );
    const submit = button('Queue task', () => form.requestSubmit(), 'primary');
    submit.id = 'queue-task';
    submit.style.width = '100%';
    form.append(submit);
    const start = button('Queue & start chat', () => submitTask(true), 'quiet');
    start.style.width = '100%';
    const footer = node('div');
    footer.className = 'composer-actions';
    footer.append(submit, start);
    form.append(footer);
    panel.append(form);
    let saving = false;
    async function submitTask(startNow) {
      if (saving) return;
      saving = true;
      submit.disabled = true;
      start.disabled = true;
      try {
        const task = await call('create', {
          title: title.value,
          prompt: prompt.value,
          cwd: taskDraft.cwd,
        });
        taskDraft = { title: '', prompt: '', cwd: '' };
        mode = 'saved';
        closePanel();
        view = startNow ? 'updates' : 'queued';
        showAll = false;
        render();
        notice('Task queued');
        if (startNow) startTask(task.id);
      } catch (error) {
        notice(error.message, true);
      } finally {
        saving = false;
        submit.disabled = false;
        start.disabled = false;
      }
    }
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      submitTask(false);
    });
    prompt.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        submitTask(event.shiftKey);
      }
    });
    queueMicrotask(() => (advanced ? prompt.focus() : title.focus()));
  }
  function groupEditor(id) {
    const group = state.groups?.find((g) => g.id === id);
    openPanel('group', group ? 'Edit chat group' : 'Group chats');
    const panel = $('panel'),
      title = node('input', '', { id: 'group-title', maxlength: '100', placeholder: 'Group name' }),
      search = node('input', '', {
        'aria-label': 'Search chats',
        placeholder: 'Search source chat names…',
      }),
      chosen = new Set(group?.threads || []),
      list = node('div'),
      count = node('p');
    title.value = group?.title || '';
    list.className = 'group-list';
    count.className = 'field-note';
    const sources = [
      ...new Map(
        state.cards
          .filter((c) => c.kind === 'observed')
          .flatMap((c) => c.sources)
          .map((s) => [s.id, s]),
      ).values(),
    ].sort((a, b) => a.title.localeCompare(b.title));
    panel.append(
      node('h2', group ? 'Keep related chats together' : 'One card for related chats', {
        class: 'panel-title',
      }),
      node('label', 'Group name', { class: 'field-label', for: 'group-title' }),
      title,
      node('p', 'Selected chats move into this group. Each keeps its original conversation.', {
        class: 'field-note',
      }),
      search,
      count,
      list,
    );
    function draw() {
      list.replaceChildren();
      count.textContent = chosen.size + ' selected';
      const visible = sources
        .filter((s) => s.title.toLowerCase().includes(search.value.toLowerCase()))
        .sort((a, b) => Number(chosen.has(b.id)) - Number(chosen.has(a.id)))
        .slice(0, 50);
      for (const source of visible) {
        const label = node('label'),
          box = node('input', '', { type: 'checkbox' });
        label.className = 'group-choice';
        box.checked = chosen.has(source.id);
        box.addEventListener('change', () => {
          box.checked ? chosen.add(source.id) : chosen.delete(source.id);
          count.textContent = chosen.size + ' selected';
        });
        label.append(box, node('span', source.title));
        list.append(label);
      }
      if (!visible.length) list.append(node('p', 'No matching chats', { class: 'field-note' }));
    }
    search.addEventListener('input', draw);
    draw();
    panel.append(
      button(
        'Save group',
        async () => {
          try {
            const next = await call('group', { id, ids: [...chosen], title: title.value });
            state = { ...state, ...next, settings: state.settings };
            closePanel();
            notice('Group saved · Undo is available');
          } catch (error) {
            notice(error.message, true);
          }
        },
        'primary full',
      ),
    );
    if (group)
      panel.append(
        button(
          'Ungroup these chats',
          async () => {
            try {
              const next = await call('group', { id, action: 'remove' });
              state = { ...state, ...next, settings: state.settings };
              closePanel();
              notice('Chats ungrouped · Undo is available');
            } catch (error) {
              notice(error.message, true);
            }
          },
          'quiet full',
        ),
      );
  }
  function groupManager() {
    openPanel('groups', 'Chat groups');
    const panel = $('panel');
    panel.append(
      node('h2', 'Keep related work together', { class: 'panel-title' }),
      button('Create a group', () => groupEditor(), 'primary full'),
    );
    for (const group of state.groups || [])
      panel.append(
        button(
          group.title + ' · ' + group.threads.length + ' chats',
          () => groupEditor(group.id),
          'settings-button',
        ),
      );
  }
  function showSettings() {
    openPanel('settings', 'Queue settings');
    const panel = $('panel');
    panel.append(node('h2', 'Make it yours', { class: 'panel-title' }));
    panel.append(node('p', 'Work Updates ' + state.version, { class: 'field-note' }));
    for (const [key, label] of [
      ['pin', 'Keep above other windows'],
      [
        'corner',
        state.platform === 'win32'
          ? 'Open queue from the weather area'
          : 'Bottom-left hover launcher',
      ],
      ['attention', 'Notify me when a task needs me'],
    ]) {
      const row = node('div');
      row.className = 'setting-row';
      const checkbox = node('input', '', { type: 'checkbox', id: 'setting-' + key });
      checkbox.checked = !!state.settings[key];
      checkbox.addEventListener('change', () =>
        call('settings', { [key]: checkbox.checked }).catch((error) => notice(error.message, true)),
      );
      row.append(node('label', label, { for: 'setting-' + key }), checkbox);
      panel.append(row);
    }
    panel.append(
      node('p', 'Toggle queue: ' + (state.settings.shortcut || 'Ctrl+Alt+Space'), {
        class: 'field-note',
      }),
      node(
        'p',
        state.platform === 'win32'
          ? 'Hover the taskbar weather to peek. Click there or in the queue to keep it open; drag the top to move it. Click the weather again to hide. Turn this off to restore normal Widgets clicks.'
          : 'Hover the bottom-left launcher to peek. Click the launcher or queue to keep it open; drag the top to move it. Click the launcher again to hide.',
        { class: 'field-note' },
      ),
    );
    if (state.platform === 'win32')
      panel.append(node('p', state.launcher?.message || '', { class: 'field-note' }));
    panel.append(
      button(
        showHidden ? 'Back to visible updates' : 'Snoozed & reviewed updates',
        () => {
          showHidden = !showHidden;
          view = 'updates';
          closePanel();
        },
        'settings-button',
      ),
      button(
        browseAll ? 'Show recent queue' : 'Browse all ' + state.monitoredCount + ' chats',
        () => {
          browseAll = !browseAll;
          showHidden = false;
          view = 'updates';
          closePanel();
        },
        'settings-button',
      ),
    );
    panel.append(
      button('Manage chat groups', groupManager, 'settings-button'),
      button(
        'Refresh chats',
        async () => {
          try {
            await call('refresh');
            notice('Refreshing local chats');
          } catch (error) {
            notice(error.message, true);
          }
        },
        'settings-button',
      ),
    );
    panel.append(
      node('div', 'Your other desktop', { class: 'setting-heading' }),
      node(
        'p',
        'Pair the native Mac app privately with this desktop. Your chats stay between the paired devices.',
        { class: 'field-note' },
      ),
    );
    const address = node('select', '', { 'aria-label': 'Private interface address' });
    if (!state.addresses?.length)
      address.append(node('option', 'No private network address available', { value: '' }));
    for (const host of state.addresses || [])
      address.append(
        node(
          'option',
          host + (host.startsWith('100.') ? ' · private overlay network' : ' · local network'),
          { value: host },
        ),
      );
    panel.append(
      address,
      button(
        'Copy pairing code',
        async () => {
          try {
            const result = await call('pair', { host: address.value });
            notice(result.message);
            closePanel();
          } catch (error) {
            notice(error.message, true);
          }
        },
        'settings-button',
      ),
    );
    if (state.hosting)
      panel.append(
        button(
          'Revoke device pairing',
          async () => {
            try {
              const result = await call('revoke');
              notice(result.message);
              closePanel();
            } catch (error) {
              notice(error.message, true);
            }
          },
          'settings-button',
        ),
      );
    const code = node('textarea', '', {
      placeholder: 'Paste a pairing code from your other desktop…',
      'aria-label': 'Pairing code',
      rows: '2',
    });
    panel.append(
      code,
      button(
        'Connect to desktop',
        async () => {
          try {
            const result = await call('connect', { code: code.value });
            code.value = '';
            notice(result.message);
            closePanel();
          } catch (error) {
            notice(error.message, true);
          }
        },
        'settings-button',
      ),
    );
    if (state.remote)
      panel.append(
        button(
          'Disconnect this device',
          async () => {
            await call('disconnect');
            closePanel();
          },
          'settings-button',
        ),
      );
    panel.append(
      node('div', 'App updates', { class: 'setting-heading' }),
      button(
        'Check GitHub releases ↗',
        async () => {
          try {
            const result = await call('updates');
            if (result.message) notice(result.message);
          } catch (error) {
            notice(error.message, true);
          }
        },
        'settings-button',
      ),
      button(
        'Quit Work Updates',
        () => call('window', { action: 'quit' }),
        'settings-button quiet',
      ),
    );
  }
  $('scrim').addEventListener('pointerdown', (event) => {
    if (event.target === $('scrim')) closePanel();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      mode ? closePanel() : call('window', { action: 'hide' });
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'n') {
      event.preventDefault();
      showComposer();
    }
    if (event.key === 'Tab' && mode) {
      const focusable = [
        ...$('panel').querySelectorAll(
          'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary',
        ),
      ].filter((element) => element.getClientRects().length && !element.closest('[inert]'));
      const first = focusable[0],
        last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  bindPress(
    $('new-task'),
    () => showComposer(),
    () => showComposer(true),
  );
  $('settings').addEventListener('click', showSettings);
  $('hide').addEventListener('click', () => call('window', { action: 'hide' }));
  $('undo').addEventListener('click', async () => {
    await call('undo');
    notice('Undone');
  });
  $('show-all').addEventListener('click', () => {
    showAll = !showAll;
    render();
  });
  $('view-menu').addEventListener('click', () => {
    const panel = openPanel('views', 'Your queue');
    panel.append(node('h2', 'Choose a view', { class: 'panel-title' }));
    for (const [key, label] of [
      ['updates', 'Updates'],
      ['queued', 'Queued'],
      ['done', 'Done'],
    ]) {
      const choice = button(
        label + (key === 'queued' && state.queued ? ' · ' + state.queued : ''),
        () => {
          view = key;
          showAll = false;
          showHidden = false;
          closePanel();
        },
        'view-choice',
      );
      choice.dataset.view = key;
      if (view === key) choice.setAttribute('aria-current', 'page');
      panel.append(choice);
    }
    panel.append(button('＋ New task', () => showComposer(), 'view-choice'));
  });
  api.subscribe((value) => {
    state = value;
    presentWindow(value);
    if (value.openComposer) showComposer();
    if (mode === 'details') updateDetails();
    else if (!mode) render();
  });
  call('state')
    .then((value) => {
      state = value;
      presentWindow(value);
      render();
    })
    .catch((error) => notice(error.message, true));
  clock();
  setInterval(() => {
    clock();
    if (!mode) render();
  }, 60000);
}
