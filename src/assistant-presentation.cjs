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

module.exports = {presentAnswer};
