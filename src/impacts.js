'use strict';

const { notFound, conflict } = require('./errors');
const { keyOf } = require('./store');
const { appendChain } = require('./penalties');

/**
 * 追溯规则发布时生成影响清单：
 * 命中窗口内、由其他规则版本立案、且按新阶梯处罚额会变化的既有处罚。
 * 只生成清单，绝不改动原处罚；重复生成按唯一键去重（幂等）。
 */
function generateImpacts(store, idx, clock, rule) {
  const from = new Date(rule.effective_from).getTime();
  const to = rule.effective_to === null ? Infinity : new Date(rule.effective_to).getTime();
  const now = clock.now().toISOString();
  const hitCases = store.where('cases', (c) => {
    const t = new Date(c.event_time).getTime();
    return t >= from && t < to && c.rule_version_id !== rule.id;
  });
  const created = [];
  for (const c of hitCases) {
    const penalties = store.where('penalties', (p) => p.case_id === c.id);
    for (const p of penalties) {
      const esc = p.escalation_id ? store.get('escalations', p.escalation_id) : null;
      if (!esc) continue;
      const step = (rule.payload.ladder || []).find((s) => s.level === esc.level);
      if (!step) continue;
      const after = step.penalty_points;
      if (after === p.amount) continue;
      const impact = {
        id: store.nextId('imp'),
        rule_version_id: rule.id,
        case_id: c.id,
        penalty_id: p.id,
        kind: 'WOULD_CHANGE_PENALTY',
        status: 'PENDING',
        detail: {
          level: esc.level,
          before_amount: p.amount,
          after_amount: after,
          penalty_status: p.status,
          note: '追溯规则不覆盖原处罚，确认后追加更正与复核',
        },
        created_at: now,
        confirmed_at: null,
        dismissed_at: null,
        dismiss_reason: null,
      };
      const dupKey = keyOf(impact.rule_version_id, '|', impact.case_id, '|', impact.penalty_id, '|', impact.kind);
      if (store.lookup(idx.impactDedup, dupKey)) continue; // 幂等：重复发布/重复生成不产生双记录
      store.assertUnique(idx.impactDedup, impact);
      store.insert('impacts', impact);
      created.push(impact);
    }
  }
  return created;
}

function mustGetImpact(store, id) {
  const impact = store.get('impacts', id);
  if (!impact) throw notFound('IMPACT_NOT_FOUND', `影响清单项不存在: ${id}`);
  return impact;
}

/**
 * 确认影响清单项：追加更正（delta 记录）与复核，并把两条处理链挂到处罚详情。
 * 原处罚金额保持不变（无论是否锁定）；重复确认幂等返回既有更正。
 */
function confirmImpact(store, idx, clock, id, { operator = 'system', note = null } = {}) {
  return store.tx(() => {
    const impact = mustGetImpact(store, id);
    if (impact.status === 'CONFIRMED') {
      const correction = store.lookup(idx.correctionImpact, keyOf(impact.id));
      const review = correction ? store.lookup(idx.reviewCorrection, keyOf(correction.id)) : null;
      return { impact, correction, review, idempotent: true };
    }
    if (impact.status !== 'PENDING') {
      throw conflict('IMPACT_STATE_CONFLICT', `当前状态 ${impact.status} 不允许确认`);
    }
    const now = clock.now().toISOString();
    const delta = impact.detail.after_amount - impact.detail.before_amount;
    const correction = {
      id: store.nextId('cor'),
      impact_id: impact.id,
      penalty_id: impact.penalty_id,
      case_id: impact.case_id,
      rule_version_id: impact.rule_version_id,
      delta,
      note: note || '追溯规则影响确认：追加更正，原处罚保留',
      created_by: operator,
      created_at: now,
    };
    store.assertUnique(idx.correctionImpact, correction);
    store.insert('corrections', correction);
    const review = {
      id: store.nextId('rev'),
      correction_id: correction.id,
      result: 'CONFIRMED',
      reviewer: operator,
      note,
      created_at: now,
    };
    store.assertUnique(idx.reviewCorrection, review);
    store.insert('reviews', review);
    if (impact.penalty_id) {
      const penalty = store.get('penalties', impact.penalty_id);
      appendChain(store, penalty.id, {
        kind: 'CORRECTION',
        ref_id: correction.id,
        note: `影响清单确认：更正 ${delta >= 0 ? '+' : ''}${delta}（原处罚 ${penalty.amount} 保留不覆盖）`,
        at: now,
      });
      appendChain(store, penalty.id, {
        kind: 'REVIEW',
        ref_id: review.id,
        note: `复核通过：${review.reviewer}`,
        at: now,
      });
    }
    impact.status = 'CONFIRMED';
    impact.confirmed_at = now;
    return { impact, correction, review, idempotent: false };
  });
}

function dismissImpact(store, idx, clock, id, { operator = 'system', reason } = {}) {
  return store.tx(() => {
    const impact = mustGetImpact(store, id);
    if (impact.status !== 'PENDING') {
      throw conflict('IMPACT_STATE_CONFLICT', `当前状态 ${impact.status} 不允许驳回`);
    }
    impact.status = 'DISMISSED';
    impact.dismissed_at = clock.now().toISOString();
    impact.dismiss_reason = reason || null;
    impact.dismissed_by = operator;
    return impact;
  });
}

function listImpacts(store, query = {}) {
  let rows = store.all('impacts');
  if (query.status) rows = rows.filter((i) => i.status === query.status);
  if (query.rule_version_id) rows = rows.filter((i) => i.rule_version_id === query.rule_version_id);
  if (query.case_id) rows = rows.filter((i) => i.case_id === query.case_id);
  return rows.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

module.exports = { generateImpacts, confirmImpact, dismissImpact, listImpacts, mustGetImpact };
