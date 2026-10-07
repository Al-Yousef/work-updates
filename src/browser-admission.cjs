'use strict';
function admission(scope, { executors, workControls, responsibilities, privacy, unavailable }) {
  try {
    const entry = scope.grantId
      ? executors.state.entries.find((e) => e.id === scope.grantId && e.taskId === scope.taskId)
      : executors.thread(scope.threadId);
    if (
      !entry ||
      entry.taskId !== scope.taskId ||
      entry.access !== 'active' ||
      entry.actorId !== executors.actorId ||
      entry.deviceId !== executors.deviceId ||
      !entry.threadId ||
      (scope.threadId && entry.threadId !== scope.threadId) ||
      unavailable?.() ||
      privacy?.activeRemoval ||
      privacy?.disconnected(entry.threadId) ||
      workControls.closed ||
      workControls.storageFailed ||
      workControls.active('all', 'all') ||
      workControls.active('executor', entry.deviceId) ||
      workControls.active('main', entry.taskId)
    )
      return 'deny';
    const related = responsibilities.state.entries.filter(
      (r) => r.scope.sourceId === entry.threadId || r.id === entry.taskId,
    );
    return related.some((r) => workControls.responsibilityAdmission(r) !== 'allow')
      ? 'deny'
      : 'allow';
  } catch {
    return 'deny';
  }
}
module.exports = { admission };
