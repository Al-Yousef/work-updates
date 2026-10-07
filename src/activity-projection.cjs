'use strict';
const { identity } = require('./activity.cjs');
const phase = (status) =>
  ({
    completed: 'completed',
    completed_run: 'completed',
    accepted: 'accepted',
    sent: 'accepted',
    uncertain: 'unknown',
    failed: 'failed',
    cancelled: 'cancelled',
    unconfirmed: 'unknown',
    unknown: 'unknown',
    acknowledged: 'acknowledged',
    not_sent: 'not_sent',
    'not-sent': 'not_sent',
    dispatching: 'started',
    sending: 'started',
    prepared: 'planned',
    waiting_human: 'held',
    waiting_user: 'held',
    waiting_approval: 'held',
    handoff: 'held',
  })[status] || 'observed';
function capture(activity, stores, initial) {
  const synthetic = activity.options.synthetic === true,
    rows = [],
    observe = (key, e) => rows.push({ key, value: { synthetic, ...e } }),
    r = stores.responsibilities,
    research = stores.research,
    triage = stores.triage,
    policy = stores.policy;
  for (const e of r?.state.entries || []) {
    const s = e.currentStep,
      links = {
        responsibilityId: e.id,
        stepId: s.id,
        ...(s.turnId ? { turnId: s.turnId } : {}),
        ...(e.delegationId ? { delegationId: e.delegationId } : {}),
        ...(s.schedule ? { scheduleId: s.schedule.id, runId: s.schedule.runId } : {}),
      },
      scope = identity(e.scope);
    observe('step:' + e.id, {
      type: 'worker_run',
      phase: phase(s.status),
      status: s.status,
      reason: 'owned_step_transition',
      scope,
      links,
      evidence: s.turnId ? 'source_status' : 'none',
    });
    observe('waiting:' + e.id, {
      type: 'waiting',
      phase: phase(e.state),
      status: e.state,
      reason: e.wakeReason?.kind || 'waiting_state',
      scope,
      links: {
        ...links,
        ...(e.wakeReason?.operationId ? { requestId: e.wakeReason.operationId } : {}),
      },
      evidence: 'source_status',
    });
  }
  for (const e of research?.state.entries || []) {
    const scan = e.scans.at(-1),
      scope = identity(e.scope, 'codex_store', e.storeId);
    if (scan)
      observe('read:' + e.id, {
        type: 'source_read',
        phase: scan.status === 'bounded_original_records' ? 'completed' : 'held',
        status: scan.status,
        plannedAt: e.attempts.find((a) => a.id === scan.id)?.at || null,
        reason:
          scan.status === 'bounded_original_records' ? 'validated_reader_result' : 'reader_gap',
        scope,
        links: {
          researchId: e.id,
          operationId: scan.id,
          ...(scan.status === 'bounded_original_records' && e.records.at(-1)
            ? { sourceRecordId: e.records.at(-1).id }
            : {}),
        },
        coverage: {
          recordCount: scan.coverage?.includedRecords ?? null,
          recordLimit: e.config.recordLimit,
          historyGap: true,
          acceptedForResearch: scan.status === 'bounded_original_records',
        },
        evidence: scan.status === 'bounded_original_records' ? 'retained_source_record' : 'none',
      });
  }
  for (const e of stores.delegations?.state.entries || []) {
    const links = {
      delegationId: e.id,
      parentId: e.parentId,
      childId: e.childId,
      responsibilityId: e.childId,
      ...(e.output?.turnId ? { turnId: e.output.turnId } : {}),
    };
    observe('child:' + e.id, {
      type: 'delegated_run',
      phase: phase(e.phase),
      status: e.phase,
      plannedAt: e.createdAt,
      reason: 'delegation_transition',
      scope: identity(e.scope),
      links,
      evidence: e.output ? 'retained_source_record' : 'none',
    });
  }
  for (const e of stores.schedules?.state.entries || []) {
    const run = e.runs.at(-1),
      grant = policy?.state.grants.find((g) => g.id === e.grant.authorizationId),
      responsibility = r?.state.entries.find((x) => x.id === e.responsibilityId);
    observe('schedule:' + e.id, {
      type: 'schedule',
      phase: phase(run?.status || e.state),
      status: run?.status || e.state,
      plannedAt: run?.plannedAt || e.nextWake || null,
      reason: 'schedule_transition',
      scope: identity(responsibility?.scope || grant?.scope || e.grant),
      links: {
        scheduleId: e.id,
        ...(e.responsibilityId ? { responsibilityId: e.responsibilityId } : {}),
        ...(run ? { runId: run.id } : {}),
        ...(run?.turnId ? { turnId: run.turnId } : {}),
      },
      evidence: run?.turnId ? 'source_status' : 'none',
    });
  }
  for (const o of (policy?.state.operations || []).slice(-128)) {
    const grant = policy.state.grants.find((g) => g.id === o.grantId);
    observe('approval:' + o.id, {
      type: 'approval',
      phase: phase(o.state),
      status: o.state,
      reason: 'approval_state',
      scope: identity(
        grant?.scope,
        grant?.scope.accountKind || 'unestablished',
        grant?.scope.accountId,
      ),
      links: {
        requestId: o.id,
        operationId: o.id,
        ...(grant?.responsibilityId ? { responsibilityId: grant.responsibilityId } : {}),
      },
    });
  }
  for (const m of (stores.messages?.state.entries || []).slice(-300)) {
    const responsibility = r?.state.entries.find(
      (e) => e.currentStep.messageId === m.id || e.pastSteps?.some((s) => s.messageId === m.id),
    );
    const proof = m.receiptIdentity,
      verified =
        proof?.messageId === m.id &&
        proof.sourceId === m.sourceId &&
        proof.textHash === m.textHash &&
        proof.turnId === m.receipt?.turnId;
    observe('message:' + m.id, {
      type: 'source_message',
      phase: phase(m.status),
      status: m.status,
      plannedAt: m.createdAt || null,
      actualEndAt: verified ? m.completedAt || null : null,
      reason: 'explicit_source_message',
      scope: identity(responsibility?.scope || { sourceId: m.sourceId, taskKey: m.taskKey }),
      links: {
        messageId: m.id,
        cardId: m.cardId,
        ...(responsibility ? { responsibilityId: responsibility.id } : {}),
        ...(verified ? { turnId: proof.turnId } : {}),
        ...(m.scheduleId ? { scheduleId: m.scheduleId, runId: m.runId } : {}),
      },
      evidence: verified ? 'source_status' : 'none',
    });
  }
  for (const rule of triage?.state.rules || []) {
    const links = { responsibilityId: rule.responsibilityId },
      scope = identity(rule.binding);
    const finding = triage.state.findings.findLast((f) => f.ruleId === rule.id),
      decision = triage.state.decisions.findLast((d) => d.ruleId === rule.id);
    if (finding)
      observe('finding:' + rule.id, {
        type: 'finding',
        status: {
          needs_user: 'waiting_user',
          ready: 'ready',
          blocked: 'blocked',
          failure: 'failed',
          urgent: 'waiting_user',
          routine: 'running',
        }[finding.kind],
        reason: 'worker_finding',
        scope,
        links: { ...links, findingId: finding.id, stepId: finding.stepId },
        coverage: { historyGap: true },
        evidence: 'source_status',
      });
    if (decision)
      observe('decision:' + rule.id, {
        type: 'notification_decision',
        status: decision.decision,
        reason: decision.reason,
        scope,
        links: {
          ...links,
          ...(finding?.hash === decision.findingHash ? { findingId: finding.id } : {}),
        },
      });
  }
  for (const d of triage?.state.deliveries || []) {
    const rule = triage.state.rules.find((r) => r.id === d.ruleId);
    if (!rule) continue;
    observe('delivery:' + d.id, {
      type: 'notification',
      phase: phase(d.status),
      status: d.status,
      plannedAt: d.preparedAt,
      actualEndAt: d.receipt?.at || null,
      reason: d.reason,
      scope: identity(rule.binding, 'notification_destination', d.destination.deviceId),
      links: {
        responsibilityId: rule.responsibilityId,
        findingId: d.findingId,
        notificationId: d.id,
      },
      synthetic: d.synthetic || d.receipt?.synthetic || false,
      evidence: d.receipt?.kind || 'none',
    });
  }
  return rows;
}
module.exports = { capture };
