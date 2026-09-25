'use strict';

const { notFound, conflict } = require('./errors');

/** 向处罚处理链追加条目（只追加，永不修改历史条目） */
function appendChain(store, penaltyId, { kind, ref_id = null, note, at }) {
  const seq = store.where('chain_entries', (e) => e.penalty_id === penaltyId).length + 1;
  return store.insert('chain_entries', {
    id: store.nextId('chn'),
    penalty_id: penaltyId,
    seq,
    kind,
    ref_id,
    note,
    at,
  });
}

function mustGetPenalty(store, id) {
  const penalty = store.get('penalties', id);
  if (!penalty) throw notFound('PENALTY_NOT_FOUND', `处罚不存在: ${id}`);
  return penalty;
}

/**
 * 锁定处罚：OPEN → LOCKED，幂等。
 * 锁定后金额不可覆盖；追溯规则命中时只能经影响清单确认后追加更正与复核。
 */
function lockPenalty(store, clock, id) {
  return store.tx(() => {
    const penalty = mustGetPenalty(store, id);
    if (penalty.status === 'LOCKED') {
      return { penalty, idempotent: true };
    }
    if (penalty.status !== 'OPEN') {
      throw conflict('PENALTY_STATE_CONFLICT', `当前状态 ${penalty.status} 不允许锁定`);
    }
    penalty.status = 'LOCKED';
    penalty.locked_at = clock.now().toISOString();
    appendChain(store, penalty.id, {
      kind: 'LOCK',
      note: '处罚锁定，金额封存不可覆盖',
      at: penalty.locked_at,
    });
    return { penalty, idempotent: false };
  });
}

/** 处罚详情 + 规则链（冻结快照 → 升级 → 锁定 → 更正 → 复核，按 seq 排序） */
function getPenaltyDetail(store, id) {
  const penalty = mustGetPenalty(store, id);
  const chain = store
    .where('chain_entries', (e) => e.penalty_id === id)
    .sort((a, b) => a.seq - b.seq);
  const corrections = store.where('corrections', (c) => c.penalty_id === id);
  const reviews = corrections
    .map((c) => store.where('reviews', (r) => r.correction_id === c.id))
    .flat();
  const escalation = penalty.escalation_id ? store.get('escalations', penalty.escalation_id) : null;
  const caseRow = store.get('cases', penalty.case_id);
  return {
    ...penalty,
    // 原始金额始终为冻结值；更正仅作为增量记录呈现，绝不覆盖
    corrections_total: corrections.reduce((sum, c) => sum + c.delta, 0),
    escalation,
    case: caseRow
      ? { id: caseRow.id, case_no: caseRow.case_no, event_time: caseRow.event_time, category: caseRow.category }
      : null,
    corrections,
    reviews,
    rule_chain: chain,
  };
}

module.exports = { appendChain, mustGetPenalty, lockPenalty, getPenaltyDetail };
