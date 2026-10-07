'use strict';
const crypto = require('node:crypto');
const { context, revision } = require('./assistant-context.cjs');
const { fresh, sourceFor } = require('./assistant-coordination.cjs');
const hash = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const held = () =>
  Object.assign(
    new Error(
      'Selected voice context changed or is unavailable. Preview it again and give fresh consent.',
    ),
    { code: 'VOICE_CONTEXT_HELD' },
  );
function validateMetadata(value) {
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'capturedAt,coverage,digest,selection' ||
    !/^[a-f0-9]{64}$/.test(value.digest) ||
    !Number.isFinite(value.capturedAt) ||
    value.capturedAt <= 0 ||
    !value.selection ||
    Object.keys(value.selection).sort().join(',') !== 'id,ownerId,revision,sourceId,taskKey' ||
    Object.values(value.selection).some((v) => typeof v !== 'string' || !v || v.length > 512) ||
    !value.coverage ||
    value.coverage.fullHistory !== false ||
    Buffer.byteLength(JSON.stringify(value)) > 4096
  )
    throw held();
}
class VoiceContext {
  constructor(options) {
    this.options = options;
  }
  scope(selection, snapshot = this.options.snapshot()) {
    if (
      !selection ||
      Object.keys(selection).sort().join(',') !== 'id,ownerId,revision,sourceId,taskKey' ||
      Object.values(selection).some((v) => typeof v !== 'string' || !v || v.length > 512) ||
      !fresh(snapshot)
    )
      throw held();
    const match = sourceFor(snapshot, selection);
    if (
      !match ||
      match.card.id !== selection.id ||
      match.card.taskKey !== selection.taskKey ||
      match.card.owner?.online === false ||
      this.options.admission(selection) !== 'allow'
    )
      throw held();
    return match;
  }
  choices() {
    const snapshot = this.options.snapshot();
    if (!fresh(snapshot))
      return {
        choices: [],
        reason: 'Task state is stale or unavailable. No context can be shared.',
      };
    const choices = [];
    for (const card of [...(snapshot.cards || []), ...(snapshot.done || [])])
      for (const source of card.sources || []) {
        if (choices.length >= 128) break;
        const selection = {
          id: card.id,
          taskKey: card.taskKey,
          sourceId: source.id,
          ownerId: card.owner?.id || 'local',
          revision: revision(card),
        };
        try {
          this.scope(selection, snapshot);
        } catch {
          continue;
        }
        choices.push({
          selection,
          title: String(card.chatName || card.title || 'Task').slice(0, 180),
          device: String(card.owner?.name || 'Local device').slice(0, 160),
          status: card.status,
          coverage:
            source.contextLoaded && source.conversationLoaded
              ? 'Bounded excerpts; full history is not shared'
              : 'Incomplete task history',
        });
      }
    return { choices, reason: choices.length ? '' : 'No currently available task context.' };
  }
  preview(selection) {
    const snapshot = this.options.snapshot(),
      { card, source } = this.scope(selection, snapshot);
    if (revision(card) !== selection.revision) throw held();
    // Build context from this source only. Other cards, memory, attachment paths,
    // credentials and unselected conversations never enter the provider payload.
    const isolated = {
      ...snapshot,
      cards: [{ ...card, primarySourceId: source.id, sources: [source] }],
      done: [],
    };
    const selected = context(isolated, 'this task', { focus: selection }).data.cards[0];
    if (!selected) throw held();
    const data = {
      task: selected.task,
      chatName: selected.chatName,
      status: selected.status,
      summary: selected.summary,
      summaryProvenance: selected.summaryProvenance,
      excerpt: selected.excerpt || '',
      conversation: selected.conversation || [],
      coverage: {
        ...selected.sourceCoverage,
        fullHistory: false,
        selection: 'one explicitly selected task snapshot',
      },
    };
    if (Buffer.byteLength(JSON.stringify(data)) > 8192) throw held();
    // A collector timestamp may advance without changing the previewed content.
    const digest = hash({ ...data, coverage: { ...data.coverage, collectedAt: 0 } });
    return {
      selection: { ...selection },
      digest,
      data,
      warning:
        'This is a bounded snapshot, not live execution proof. Missing and truncated history remains unknown.',
    };
  }
  capture({ selection, digest, confirmed }) {
    if (confirmed !== true) throw held();
    const preview = this.preview(selection);
    if (preview.digest !== digest) throw held();
    return {
      selection: preview.selection,
      digest,
      data: preview.data,
      capturedAt: Date.now(),
      label: 'One consented task snapshot; full history is not shared',
    };
  }
  assertCurrent(value) {
    if (this.preview(value.selection).digest !== value.digest) throw held();
  }
  available(value) {
    try {
      this.scope(value.selection);
      return true;
    } catch {
      return false;
    }
  }
}
module.exports = { VoiceContext, validateMetadata };
