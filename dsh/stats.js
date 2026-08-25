// 效果统计：漏斗转化、分层回复率、市场分布、触达量。全部从 CRM/审计推导，
// 不需要额外埋点。回复数据来自 replies.js 的自动检测。
import * as crm from './crm.js';
import { queryAudit } from './audit.js';
import { suppressStats } from './suppress.js';
import { trackStats } from './track.js';

export function report() {
  const leads = crm.listLeads({ limit: 5000 });
  const funnel = {};
  for (const status of crm.STATUSES) {
    funnel[status] = leads.filter((lead) => lead.status === status).length;
  }
  const contacted = leads.filter((lead) => ['contacted', 'replied', 'quoted', 'won', 'lost'].includes(lead.status));
  const replied = leads.filter((lead) => ['replied', 'quoted', 'won'].includes(lead.status));
  const won = leads.filter((lead) => lead.status === 'won');

  // 分层回复率
  const byTier = {};
  for (const tier of ['极高', '高', '中', '低']) {
    const tierLeads = contacted.filter((lead) => lead.tier === tier);
    const tierReplied = replied.filter((lead) => lead.tier === tier);
    byTier[tier] = {
      contacted: tierLeads.length,
      replied: tierReplied.length,
      replyRate: tierLeads.length > 0 ? `${Math.round((tierReplied.length / tierLeads.length) * 100)}%` : '-',
    };
  }

  // 市场分布
  const byMarket = {};
  for (const lead of contacted) {
    const market = lead.market || 'unknown';
    byMarket[market] = byMarket[market] || { contacted: 0, replied: 0 };
    byMarket[market].contacted += 1;
    if (['replied', 'quoted', 'won'].includes(lead.status)) {
      byMarket[market].replied += 1;
    }
  }

  // 回复分类分布（最近回复）
  const replyCategories = {};
  for (const lead of leads) {
    if (lead.lastReply?.category) {
      replyCategories[lead.lastReply.category] = (replyCategories[lead.lastReply.category] ?? 0) + 1;
    }
  }

  // 触达量（审计）
  const emailSent = queryAudit({ action: 'email.send', limit: 1000 }).length;
  const emailDryRun = queryAudit({ action: 'email.dry_run', limit: 1000 }).length;
  const waSent = queryAudit({ action: 'wa.send', limit: 1000 }).length;

  // 序列进行中
  const sequencesRunning = leads.filter((lead) => lead.sequence && lead.sequence.steps?.some((step) => step.status === 'pending')).length;

  return {
    generatedAt: new Date().toISOString(),
    funnel,
    conversion: {
      contactedTotal: contacted.length,
      repliedTotal: replied.length,
      replyRate: contacted.length > 0 ? `${Math.round((replied.length / contacted.length) * 100)}%` : '-',
      won: won.length,
      wonRate: contacted.length > 0 ? `${Math.round((won.length / contacted.length) * 100)}%` : '-',
    },
    byTier,
    byMarket,
    replyCategories,
    outreach: { emailSent, emailDryRun, waSent, sequencesRunning },
    tracking: trackStats(),
    suppressed: suppressStats().total,
    hint: '回复率低(<5%)时：换模板/换分层/换市场；极高分层回复率应显著高于低分层，否则评分标准需要校准；打开率高但回复低=内容问题，打开率低=送达率/标题问题',
  };
}
