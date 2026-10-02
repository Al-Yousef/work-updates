'use strict';
const DEVICE_LABELS = {
  pc: 'Windows PC',
  mac: 'Mac',
  linux: 'Linux PC',
  phone: 'Phone',
  tablet: 'Tablet',
  unknown: 'Device not recorded',
};
function device(value) {
  const kind = value && Object.hasOwn(DEVICE_LABELS, value.kind) ? value.kind : 'unknown';
  return { kind, label: DEVICE_LABELS[kind] };
}
function executionDevice(platform = process.platform) {
  return device({
    kind: { win32: 'pc', darwin: 'mac', linux: 'linux', ios: 'phone', android: 'phone' }[platform],
  });
}
function shortSummary(value, limit = 160) {
  const text = String(value || '')
    .replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g, '')
    .replace(/!\[([^\]]*)\]\([^\n]*?\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^\n]*?\)/g, '$1')
    .replace(/(^|\n)\s*(?:#{1,6}|[-*])\s+/g, '$1')
    .replace(/\*\*|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length <= limit
    ? text
    : text
        .slice(0, limit - 1)
        .replace(/\s+\S*$/, '')
        .trimEnd() + '…';
}
function taskSummary(task, approval) {
  if (task.error) {
    if (/active writer|already (?:running|loaded)/i.test(task.error))
      return 'This chat is active elsewhere. Open it in Codex to continue.';
    if (/too long|timed? out|timeout/i.test(task.error))
      return 'Codex did not respond in time. Retry to continue.';
    if (/disconnect/i.test(task.error)) return 'Codex disconnected. Retry to continue this chat.';
    return shortSummary(task.error);
  }
  if (task.status === 'queued') return shortSummary(task.prompt) || 'Queued and ready to start.';
  if (task.status === 'starting') return 'Starting this chat.';
  if (approval)
    return shortSummary(approval.reason) || 'Waiting for your answer before continuing.';
  const messages = task.messages || [];
  const latest = messages.findLast((m) => m.role === 'assistant');
  if (task.status === 'working' && (!latest || messages.at(-1)?.role === 'user'))
    return 'Working on your latest message.';
  return shortSummary(latest?.text) || 'No recorded update yet.';
}
module.exports = { device, executionDevice, shortSummary, taskSummary };
