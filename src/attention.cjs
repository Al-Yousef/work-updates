'use strict';
// Read only explicit statements in the latest response. Missing owners remain unknown.
function inferAttention(value = '', status = 'ready') {
  const text = String(value)
    .replace(/\*\*|`/g, '')
    .slice(0, 1800);
  const clauses = text
    .split(/[\n.!?]+/)
    .filter(
      (line) =>
        !/\b(?:not|no longer|isn't|is not) (?:waiting|awaiting|blocked|urgent)\b/i.test(line),
    );
  const you =
    status === 'needs' ||
    clauses.some((line) =>
      /\b(?:need(?:s)? your|waiting (?:on|for) you\b|(?:awaiting|waiting for|requires?|blocked (?:on|by|until)) your\b|please (?:send|provide|upload|confirm))/.test(
        line.toLowerCase(),
      ),
    );
  const urgent = clauses.some((line) =>
    /^\s*(?:[-*]\s*)?urgent\b|\b(?:this|it|the task) is urgent\b|\burgent (?:action|attention|decision)\b/i.test(
      line,
    ),
  );
  let waitingOn = { kind: you ? 'you' : 'unknown', name: '' };
  if (!you)
    for (const line of clauses) {
      const match = line.match(
        /\b(?:waiting (?:for|on)|awaiting|blocked (?:by|on|until))\s+([^,;:]+)/i,
      );
      if (!match) continue;
      const target = match[1].trim();
      const role = target.match(
        /^(?:the |a |an )?(reviewer|landlord|provider|recruiter|client|manager|support team|design team|engineering team|team|CI|build service|server)\b/i,
      );
      const named = target.match(
        /^([A-Z][\p{L}-]+(?: [A-Z][\p{L}-]+)?)(?:['’]s)?(?:\s+(?:reply|response|approval|confirmation|review)|\s+to\b|\s*$)/u,
      );
      if (role) waitingOn = { kind: 'other', name: role[1] };
      else if (
        named &&
        !/^(?:Your|The|A|An|Approval|Confirmation|Response|Reply|Someone|You)$/i.test(named[1])
      )
        waitingOn = { kind: 'other', name: named[1] };
      else if (/^(?:someone else|another person)\b/i.test(target))
        waitingOn = { kind: 'other', name: '' };
      if (waitingOn.kind !== 'unknown') break;
    }
  return { waitingOn, urgent };
}
function statusLabel(status, waitingOn) {
  const owner = waitingOn?.kind === 'you' ? 'you' : waitingOn?.name || 'someone else';
  if (status === 'needs') return 'Waiting on you';
  if (status === 'waiting')
    return waitingOn?.kind === 'unknown' ? 'Waiting · owner unclear' : 'Waiting on ' + owner;
  if (status === 'blocked' && waitingOn?.kind !== 'unknown')
    return waitingOn?.kind === 'you' ? 'Waiting on you · blocked' : 'Blocked · waiting on ' + owner;
  return (
    {
      queued: 'Queued',
      starting: 'Starting chat',
      working: 'Working',
      ready: 'Ready to review',
      blocked: 'Blocked',
      unknown: 'Check status',
      done: 'Done',
    }[status] || 'Updated'
  );
}
function priorityRank(card) {
  if (
    card.status === 'needs' ||
    (['blocked', 'waiting'].includes(card.status) && card.waitingOn?.kind === 'you')
  )
    return 0;
  if (card.urgent) return 1;
  if (card.status === 'blocked' && card.waitingOn?.kind !== 'other') return 2;
  if (card.readyForReview && card.status !== 'waiting' && card.status !== 'blocked') return 3;
  return { queued: 4, starting: 5, working: 5, waiting: 6, blocked: 6 }[card.status] ?? 7;
}
module.exports = { inferAttention, statusLabel, priorityRank };
