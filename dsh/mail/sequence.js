// 跟进序列：每条 CRM 线索可挂一个 4 步序列（Day 0/3/7/14）。
// 状态存 lead.sequence；dueSteps() 由 cron 定期驱动，发送动作在 index.js
// 的工具层完成（受 smtp.dry_run 约束），这里只管状态与到期计算。
import { SEQUENCE_PLAN } from '../mail/templates.js';

export function newSequence({ language, timezoneNote } = {}) {
  return {
    startedAt: new Date().toISOString(),
    language: language ?? 'en',
    steps: SEQUENCE_PLAN.map((step) => ({
      day: step.day,
      label: step.label,
      status: 'pending', // pending | sent | skipped | failed
      sentAt: null,
      subject: '',
      body: '',
      error: null,
    })),
  };
}

export function daysSince(iso) {
  return Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
}

/** 到期未发的步骤（day <= 已过天数）。 */
export function dueSteps(sequence) {
  if (!sequence?.startedAt) {
    return [];
  }
  const days = daysSince(sequence.startedAt);
  return sequence.steps
    .map((step, index) => ({ ...step, index }))
    .filter((step) => step.status === 'pending' && step.day <= days);
}

/** 回复即停：把所有 pending 步骤标 skipped。 */
export function stopSequence(sequence, reason = 'buyer replied') {
  for (const step of sequence?.steps ?? []) {
    if (step.status === 'pending') {
      step.status = 'skipped';
      step.error = reason;
    }
  }
  return sequence;
}

export function sequenceSummary(sequence) {
  if (!sequence) {
    return null;
  }
  return {
    startedAt: sequence.startedAt,
    language: sequence.language,
    daysRunning: daysSince(sequence.startedAt),
    steps: sequence.steps.map((step) => ({ day: step.day, label: step.label, status: step.status, sentAt: step.sentAt, error: step.error })),
    pending: sequence.steps.filter((step) => step.status === 'pending').length,
  };
}
