// SOP 阶段机（参考 dsh-sdr 思路，服务端强制顺序 + 人工审批门）：
//   parse → discover → enrich → score → draft → approval → outreach → close
// 规则：
//  - 阶段只能由 sop_next 推进，前置条件由服务端校验（agent 不能跳步）
//  - approval 阶段：每封草稿必须被 sop_approve 批准，凭证绑定内容哈希；
//    草稿被改动后哈希失配 → 必须重新审批（fail-closed）
//  - outreach：只发送"当前内容哈希=已批准哈希"的草稿，且受 smtp.dry_run 总闸
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { DATA_DIR } from './config.js';
import { audit } from './audit.js';

const FILE = join(DATA_DIR, 'sop.json');

export const STAGES = ['parse', 'discover', 'enrich', 'score', 'draft', 'approval', 'outreach', 'close'];
export const STAGE_LABELS = {
  parse: '任务解析', discover: '客户发现', enrich: '线索加工', score: '客户评分',
  draft: '开发信草稿', approval: '人工审批', outreach: '触达执行', close: '结案复盘',
};

function load() {
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
    return Array.isArray(parsed?.tasks) ? parsed : { tasks: [] };
  } catch {
    return { tasks: [] };
  }
}

function save(db) {
  mkdirSync(dirname(FILE), { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(db, null, 1), { mode: 0o600 });
  renameSync(tmp, FILE);
}

function hashDraft(draft) {
  return createHash('sha256').update(`${draft.subject}\n${draft.body}`, 'utf8').digest('hex').slice(0, 24);
}

export function createTask({ goal, product, market, params } = {}) {
  if (!String(goal ?? '').trim()) {
    throw new Error('sop task needs a goal');
  }
  const db = load();
  const task = {
    id: `T${Date.now().toString(36)}${randomUUID().slice(0, 4)}`,
    goal: String(goal).slice(0, 300),
    product: product ?? '',
    market: market ?? '',
    params: params ?? {},
    stage: 'parse',
    stageLog: [{ stage: 'parse', ts: new Date().toISOString(), note: '任务已创建' }],
    prospects: [],   // CRM lead ids
    drafts: [],      // {id, leadId, channel, to, subject, body, hash, approved: null|{ts, hash}}
    outreach: [],    // {draftId, to, channel, ts, dryRun, result}
    report: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.tasks.unshift(task);
  if (db.tasks.length > 200) {
    db.tasks.length = 200;
  }
  save(db);
  audit('sop.create', { task_id: task.id, goal: task.goal });
  return task;
}

function getTask(taskId) {
  const task = load().tasks.find((item) => item.id === taskId);
  if (!task) {
    throw new Error(`sop task not found: ${taskId}`);
  }
  return task;
}

function saveTask(task) {
  const db = load();
  const index = db.tasks.findIndex((item) => item.id === task.id);
  if (index === -1) {
    throw new Error(`sop task not found: ${task.id}`);
  }
  task.updatedAt = new Date().toISOString();
  db.tasks[index] = task;
  save(db);
}

function advance(task, note) {
  const index = STAGES.indexOf(task.stage);
  if (index === -1 || index >= STAGES.length - 1) {
    throw new Error('already at final stage');
  }
  task.stage = STAGES[index + 1];
  task.stageLog.push({ stage: task.stage, ts: new Date().toISOString(), note: note ?? '' });
  saveTask(task);
  audit('sop.stage', { task_id: task.id, to: task.stage, note: note ?? '' });
  return task;
}

/**
 * 尝试推进一个阶段。prereq: 该阶段完成所需的证据（由 index.js 的工具层组装）。
 * 返回 {task, nextHint}；前置不满足时 throw（fail-closed）。
 */
export function nextStep(taskId, prereq = {}) {
  const task = getTask(taskId);
  switch (task.stage) {
    case 'parse':
      if (!task.product || !task.market) {
        if (!prereq.product || !prereq.market) {
          throw new Error('parse 未完成：需要 product 与 market（sop_next 时传入）');
        }
        task.product = prereq.product;
        task.market = prereq.market;
        saveTask(task);
      }
      return { task: advance(task, `产品=${task.product} 市场=${task.market}`), hint: '调用 lead_search 批量搜索，然后 sop_next 传 run_id' };
    case 'discover':
      if (!prereq.runId && task.prospects.length === 0) {
        throw new Error('discover 未完成：需要先跑 lead_search 并传 run_id');
      }
      if (prereq.runId) {
        task.discoverRunId = prereq.runId;
        saveTask(task);
      }
      return { task: advance(task, `搜索 run=${task.discoverRunId ?? '已并入'}`), hint: '调用 lead_enrich 提取联系方式+分类，然后 sop_next' };
    case 'enrich':
      if (task.prospects.length === 0 && !prereq.leadIds) {
        throw new Error('enrich 未完成：需要先 lead_enrich 产出线索（leadIds 或已存 CRM）');
      }
      if (prereq.leadIds) {
        task.prospects = [...new Set([...task.prospects, ...prereq.leadIds])];
        saveTask(task);
      }
      if (task.prospects.length === 0) {
        throw new Error('enrich 未完成：没有可用线索');
      }
      return { task: advance(task, `${task.prospects.length} 条线索`), hint: '调用 lead_score 打分，然后 sop_next' };
    case 'score':
      {
        // CRM 由 index.js 注入到 globalThis.__waimaoCrm（避免 ESM 循环依赖）
        const scored = task.prospects
          .map((id) => globalThis.__waimaoCrm?.getLead?.(id))
          .filter((lead) => lead && (lead.score ?? 0) > 0);
        if (scored.length === 0) {
          throw new Error('score 未完成：没有任何线索有分数（先跑 lead_score）');
        }
        return { task: advance(task, `最高分 ${Math.max(...scored.map((lead) => lead.score))}`), hint: '对高分线索调用 email_compose 生成草稿，然后 sop_next 传 draft_ids' };
      }
    case 'draft':
      // 草稿由 email_compose(task_id=...) 挂载（attachDraft），这里只校验存在
      if (task.drafts.length === 0) {
        throw new Error('draft 未完成：需要先对高分线索调用 email_compose(task_id=本任务) 生成草稿');
      }
      return { task: advance(task, `${task.drafts.length} 封草稿待审`), hint: '人工审批：sop_review 列出草稿，sop_approve 逐封批准' };
    case 'approval':
      {
        const pending = task.drafts.filter((draft) => draft.approved?.hash !== draft.hash);
        if (pending.length > 0) {
          throw new Error(`approval 未完成：还有 ${pending.length} 封草稿未批准（fail-closed，不可跳过）`);
        }
        return { task: advance(task, '全部草稿已批准'), hint: '调用 email_send / wa_reply 执行触达（受 dry_run 约束），然后 sop_next' };
      }
    case 'outreach':
      if (prereq.sent) {
        task.outreach.push(...prereq.sent);
        saveTask(task);
      }
      if (task.outreach.length === 0 && prereq.force !== true) {
        throw new Error('outreach 未完成：还没有任何发送记录（或传 force=true 表示本轮不发送）');
      }
      return { task: advance(task, `${task.outreach.length} 次触达`), hint: '再调一次 sop_next 进入 close 阶段，自动生成结案报告' };
    case 'close':
      {
        const closed = closeTask(task.id);
        return { task: closed, report: closed.report, hint: '任务已结案' };
      }
    default:
      throw new Error(`unknown stage: ${task.stage}`);
  }
}

/** 结案：生成结构化报告。 */
export function closeTask(taskId) {
  const task = getTask(taskId);
  if (task.stage !== 'close') {
    throw new Error(`只能从 close 阶段结案，当前: ${task.stage}`);
  }
  task.report = {
    closedAt: new Date().toISOString(),
    goal: task.goal,
    product: task.product,
    market: task.market,
    prospects: task.prospects.length,
    drafts: task.drafts.length,
    approved: task.drafts.filter((draft) => draft.approved).length,
    outreach: task.outreach.length,
    dryRunOnly: task.outreach.every((item) => item.dryRun),
    stageTrail: task.stageLog,
  };
  saveTask(task);
  audit('sop.close', { task_id: task.id, report: task.report });
  return task;
}

/** 人工审批：批准绑定当前内容哈希；草稿改动后旧批准失效。 */
export function reviewDraft(taskId, draftId, { approve, actor = 'user' } = {}) {
  const task = getTask(taskId);
  if (task.stage !== 'approval') {
    throw new Error(`当前阶段是 ${task.stage}，只有 approval 阶段可审批`);
  }
  const draft = task.drafts.find((item) => item.id === draftId);
  if (!draft) {
    throw new Error(`draft not found: ${draftId}`);
  }
  const currentHash = hashDraft(draft);
  if (draft.hash !== currentHash) {
    draft.hash = currentHash;
    draft.approved = null;
    saveTask(task);
  }
  if (approve) {
    draft.approved = { ts: new Date().toISOString(), hash: currentHash, actor };
    audit('sop.approve', { task_id: taskId, draft_id: draftId, hash: currentHash }, actor);
  } else {
    draft.approved = null;
    draft.rejected = true;
    audit('sop.reject', { task_id: taskId, draft_id: draftId }, actor);
  }
  saveTask(task);
  const pending = task.drafts.filter((item) => item.approved?.hash !== item.hash).length;
  return { task, pending };
}

/** 外发前校验：草稿必须存在批准凭证且哈希与当前内容一致。 */
export function assertApproved(taskId, draftId) {
  const task = getTask(taskId);
  const draft = task.drafts.find((item) => item.id === draftId);
  if (!draft) {
    throw new Error(`draft not found: ${draftId}`);
  }
  const currentHash = hashDraft(draft);
  if (!draft.approved || draft.approved.hash !== currentHash) {
    throw new Error(`draft ${draftId} 未批准或已改动（哈希失配）——请重新 sop_approve`);
  }
  return draft;
}

/** 把一封草稿挂到任务上（index.js 的 email_compose 在 SOP 模式下调用）。 */
export function attachDraft(taskId, draft) {
  const task = getTask(taskId);
  const item = {
    id: `D${Date.now().toString(36)}${randomUUID().slice(0, 3)}`,
    leadId: draft.leadId ?? null,
    channel: draft.channel ?? 'email',
    to: draft.to ?? '',
    subject: draft.subject ?? '',
    body: draft.body ?? '',
    hash: hashDraft(draft),
    approved: null,
  };
  task.drafts.push(item);
  saveTask(task);
  return item;
}

export function listTasks({ limit = 20 } = {}) {
  return load().tasks.slice(0, limit).map((task) => summary(task));
}

export function summary(task) {
  return {
    id: task.id,
    goal: task.goal,
    stage: task.stage,
    stageLabel: STAGE_LABELS[task.stage],
    product: task.product,
    market: task.market,
    prospects: task.prospects.length,
    drafts: task.drafts.length,
    pendingApprovals: task.drafts.filter((draft) => draft.approved?.hash !== draft.hash).length,
    outreach: task.outreach.length,
    closed: Boolean(task.report),
    updatedAt: task.updatedAt,
  };
}

export function getTaskFull(taskId) {
  return getTask(taskId);
}
