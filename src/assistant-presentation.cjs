'use strict';

// Display-only formatting. Persisted answers and related-chat drafts stay exact.
// Offsets are UTF-16 code units, matching DirectWrite's text ranges.
function presentAnswer(value) {
  const raw = String(value ?? '').toWellFormed();
  let end = Math.min(raw.length, 6000);
  if (end && /[\uD800-\uDBFF]/.test(raw[end - 1])) end--;
  const source = raw.slice(0, end).replace(/\r\n?/g, '\n');
  let text = '';
  const spans = [];
  const add = (value, kind) => {
    const start = text.length;
    text += value;
    if (kind && value.length && spans.length < 128) spans.push({start, length: value.length, kind});
  };
  const inline = (line, bold = false) => {
    const tokens = /\\([*`])|`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;
    let at = 0;
    for (const match of line.matchAll(tokens)) {
      add(line.slice(at, match.index), bold ? 'bold' : undefined);
      if (match[1]) add(match[1], bold ? 'bold' : undefined);
      else if (match[2]) add(match[2], 'code');
      else inline(match[3], true);
      at = match.index + match[0].length;
    }
    add(line.slice(at), bold ? 'bold' : undefined);
  };
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i) add('\n');
    if (/^\s{0,3}```[^`]*$/.test(lines[i])) {
      let close = i + 1;
      while (close < lines.length && !/^\s{0,3}```\s*$/.test(lines[close])) close++;
      if (close < lines.length) {
        add(lines.slice(i + 1, close).join('\n'), 'code');
        i = close;
        continue;
      }
    }
    const heading = lines[i].match(/^#{1,3}\s+(.+)$/);
    inline(heading ? heading[1] : lines[i].replace(/^(\s{0,6})[-*]\s+/, '$1• '), !!heading);
  }
  return {text, spans};
}

// Automatic updates are previews, not replies to a question. Legacy entries
// contain chat name, task title, summary and status joined with newlines.
function presentUpdate(message, cards = []) {
  let saved = message.update;
  const lines = String(message.answer ?? '').toWellFormed().split('\n');
  const linkedTitle = String(message.links?.[0]?.chatName ?? '');
  // Only remove a legacy task title when the entire stored preview exactly
  // matches one source card. Ambiguous history retains all its body text.
  if (!saved) {
    const matches = cards.filter(card=>card.chatName===linkedTitle &&
      [...new Set([card.chatName||card.title,card.title,card.summary,card.label].filter(Boolean))].join('\n').slice(0,1800)===message.answer);
    if (matches.length === 1) saved = {title:matches[0].chatName,summary:matches[0].summary||'',label:matches[0].label||''};
  }
  let title, status, summary;
  if (saved && typeof saved.title === 'string' && typeof saved.summary === 'string' && typeof saved.label === 'string') {
    ({title, summary, label:status} = saved);
  } else if (linkedTitle && lines[0] === linkedTitle && lines.length >= 3) {
    title = lines.shift(); status = lines.pop();
    summary = lines.join('\n');
  } else {
    // Coordination receipts and unknown older formats retain all their text.
    return presentAnswer(message.answer);
  }
  title = title.toWellFormed().replace(/\s+/g, ' ').slice(0,180);
  status = status.toWellFormed().replace(/\s+/g, ' ').slice(0,160);
  summary = summary.toWellFormed().trim();
  if (summary.length > 280) {
    let end = summary.lastIndexOf(' ', 280);
    if (end < 200) end = 280;
    if (/[\uD800-\uDBFF]/.test(summary[end - 1])) end--;
    summary = summary.slice(0,end).trimEnd().replace(/\.{3}$/, '') + '…';
  }
  const body = presentAnswer(summary);
  const prefix = title + (status ? '\n' + status : '') + (body.text ? '\n\n' : '');
  return {text:prefix + body.text, spans:[
    ...(title ? [{start:0,length:title.length,kind:'bold'}] : []),
    ...(status ? [{start:title.length+1,length:status.length,kind:'secondary'}] : []),
    ...body.spans.slice(0,126).map(span=>({...span,start:span.start+prefix.length})),
  ]};
}

module.exports = {presentAnswer, presentUpdate};
