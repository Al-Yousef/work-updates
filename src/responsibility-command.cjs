'use strict';
const identity = '([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})';
function command(text) {
  const natural =
    typeof text === 'string' &&
    text.match(
      /^(?:(?:can|could|would) you\s+)?(?:please\s+)?keep working (?:in|on) (?:this|that) (?:chat|thread)\s*:\s*([\s\S]+)$/i,
    );
  if (natural) {
    if (natural[1].trim().length > 4000)
      throw new Error('Use an instruction of up to 4,000 characters');
    return { kind: 'start', instruction: natural[1].trim(), completionKind: 'human_verified' };
  }
  if (typeof text !== 'string' || !/^\/responsibilit(?:y|ies)(?:\s|$)/i.test(text)) return null;
  if (/^\/(?:responsibilities|responsibility list)\s*$/i.test(text)) return { kind: 'list' };
  let match = text.match(/^\/responsibility (start|start-pass)\s+([\s\S]+)$/i);
  if (match) {
    if (match[2].trim().length > 4000)
      throw new Error('Use an instruction of up to 4,000 characters');
    return {
      kind: 'start',
      instruction: match[2].trim(),
      completionKind:
        match[1].toLowerCase() === 'start-pass' ? 'source_terminal' : 'human_verified',
    };
  }
  match = text.match(
    new RegExp('^/responsibility (wake|approve|cancel|verify) ' + identity + '\\s*$', 'i'),
  );
  if (match) return { kind: match[1].toLowerCase(), id: match[2].toLowerCase() };
  match = text.match(
    new RegExp('^/responsibility steer ' + identity + '\\s*:\\s*([\\s\\S]+)$', 'i'),
  );
  if (match) return { kind: 'steer', id: match[1].toLowerCase(), instruction: match[2].trim() };
  match = text.match(
    new RegExp(
      '^/responsibility wait ' +
        identity +
        ' (user|approval|external|sleep|blocked)\\s*:\\s*([\\s\\S]+)$',
      'i',
    ),
  );
  if (match) {
    if (match[3].trim().length > 1000)
      throw new Error('Use a waiting reason of up to 1,000 characters');
    return {
      kind: 'wait',
      id: match[1].toLowerCase(),
      state: {
        user: 'waiting_user',
        approval: 'waiting_approval',
        external: 'waiting_external',
        sleep: 'sleeping',
        blocked: 'blocked',
      }[match[2].toLowerCase()],
      reason: match[3].trim(),
    };
  }
  throw new Error(
    'Use /responsibilities, or /responsibility start INSTRUCTION after opening a source chat. Existing responsibilities use their full ID: steer ID: INSTRUCTION, wait ID user|approval|external|sleep|blocked: REASON, wake ID, approve ID, cancel ID, or verify ID.',
  );
}
module.exports = { command };
