'use strict';
const identifier = (v) => typeof v === 'string' && v.length > 0 && v.length <= 512;
const hash = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const capabilities = ['task_create', 'task_continue', 'turn_interrupt'];
function validate(report, deviceId) {
  if (
    !report ||
    report.schema !== 1 ||
    report.deviceId !== deviceId ||
    !identifier(deviceId) ||
    report.location !== 'local' ||
    report.cloud !== false ||
    report.liveExecutorVerified !== false ||
    !['recorded_grants', 'storage_held'].includes(report.coverage) ||
    !['connected', 'disconnected', 'unknown'].includes(report.transport) ||
    !Number.isSafeInteger(report.reportedAt) ||
    report.reportedAt <= 0 ||
    !Array.isArray(report.grants) ||
    report.grants.length > 2048 ||
    new Set(report.grants.map((g) => g.taskId)).size !== report.grants.length ||
    (report.coverage === 'storage_held' && report.grants.length !== 0)
  )
    throw new Error('Unsupported original-device executor report.');
  for (const g of report.grants)
    if (
      !identifier(g.id) ||
      !identifier(g.taskId) ||
      (g.threadId !== null && !identifier(g.threadId)) ||
      !identifier(g.serverVersion) ||
      !['active', 'revoked'].includes(g.access) ||
      !hash(g.workspaceRef) ||
      !hash(g.accountRef) ||
      !hash(g.profileRef) ||
      !Number.isSafeInteger(g.verifiedAt) ||
      g.verifiedAt <= 0 ||
      !Array.isArray(g.capabilities) ||
      g.capabilities.join(',') !== capabilities.join(',')
    )
      throw new Error('Invalid original-device executor grant report.');
  return report;
}
function projection(report, deviceId) {
  const absent = {
    schema: 1,
    binding: 'unreported',
    deviceId,
    liveExecutorVerified: false,
    cloud: false,
    capabilities: [],
  };
  if (!report)
    return {
      summary: { schema: 1, supported: false, liveExecutorVerified: false, cloud: false },
      task: () => structuredClone(absent),
    };
  validate(report, deviceId);
  const grants = new Map(report.grants.map((g) => [g.taskId, g]));
  return {
    summary: {
      schema: 1,
      supported: true,
      coverage: report.coverage,
      transport: report.transport,
      reportedAt: report.reportedAt,
      grantCount: report.grants.length,
      revoked: report.grants.filter((g) => g.access === 'revoked').length,
      location: 'local',
      cloud: false,
      liveExecutorVerified: false,
    },
    task: (card) => {
      const candidate = grants.get(card.id),
        grant =
          candidate &&
          (candidate.threadId === null || card.sources?.some((s) => s.id === candidate.threadId))
            ? candidate
            : null;
      return {
        schema: 1,
        deviceId,
        binding:
          report.coverage === 'storage_held'
            ? 'storage_held'
            : grant
              ? 'recorded_grant'
              : 'unreported',
        location: 'local',
        cloud: false,
        liveExecutorVerified: false,
        transport: report.transport,
        reportedAt: report.reportedAt,
        ...(grant ? structuredClone(grant) : { capabilities: [] }),
      };
    },
  };
}
module.exports = { validate, projection };
