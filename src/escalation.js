'use strict';

const { DAY_MS } = require('./clock');
const { keyOf } = require('./store');
const { appendChain } = require('./penalties');

/**
 * 升级引擎（可注入时钟）：
 * 对逾期未整改的立案，按“立案时冻结的规则快照”中的阶梯逐级补齐升级记录，
 * 并生成对应处罚。同级唯一索引兜底 + 同步临界区，重复运行/并发触发不产生双记录。
 * 绝不重新解析规则——新发布的规则不影响既有立案的升级计算。
 */
function runEscalation(store, idx, clock, { caseId = null } = {}) {
  const now = clock.now();
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  return store.tx(() => {
    const targets = store.where(
      'cases',
      (c) =>
        (caseId === null || c.id === caseId) &&
        (c.status === 'FILED' || c.status === 'ESCALATING') &&
        c.rectified_at === null &&
        c.rule_snapshot != null && // 未迁移旧数据无快照，须先经模型迁移挂接基准规则
        new Date(c.deadline).getTime() < nowMs
    );
    const created = [];
    for (const c of targets) {
      const snap = c.rule_snapshot;
      const overdueDays = Math.floor((nowMs - new Date(c.deadline).getTime()) / DAY_MS);
      const steps = [...snap.payload.ladder].sort((a, b) => a.level - b.level);
      for (const step of steps) {
        if (step.overdue_days > overdueDays) continue;
        const dupKey = keyOf(c.id, '#L', step.level);
        if (store.lookup(idx.escalationCaseLevel, dupKey)) continue; // 幂等：同级已存在
        const esc = {
          id: store.nextId('esc'),
          case_id: c.id,
          level: step.level,
          overdue_days: overdueDays,
          action: step.action,
          penalty_points: step.penalty_points,
          rule_version_id: c.rule_version_id,
          created_at: nowIso,
        };
        store.assertUnique(idx.escalationCaseLevel, esc); // 并发兜底
        store.insert('escalations', esc);
        if (step.penalty_points > 0) {
          const pen = {
            id: store.nextId('pen'),
            case_id: c.id,
            escalation_id: esc.id,
            amount: step.penalty_points, // 金额封存，之后任何流程不得覆盖
            status: 'OPEN',
            locked_at: null,
            created_at: nowIso,
          };
          store.assertUnique(idx.penaltyEscalation, pen);
          store.insert('penalties', pen);
          appendChain(store, pen.id, {
            kind: 'RULE_SNAPSHOT',
            ref_id: c.rule_version_id,
            note: `立案冻结规则快照 ${snap.code} v${snap.version}`,
            at: nowIso,
          });
          appendChain(store, pen.id, {
            kind: 'ESCALATION',
            ref_id: esc.id,
            note: `逾期 ${overdueDays} 天触发 L${step.level} ${step.action}，按快照阶梯计 ${step.penalty_points} 分`,
            at: nowIso,
          });
        }
        c.status = 'ESCALATING';
        created.push(esc);
      }
    }
    return { run_at: nowIso, created };
  });
}

module.exports = { runEscalation };
