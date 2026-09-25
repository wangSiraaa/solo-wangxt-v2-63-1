'use strict';

const { keyOf } = require('./store');
const { snapshotOf } = require('./rules');

const BASELINE_RULE_CODE = 'baseline-legacy';
const BASELINE_EFFECTIVE_FROM = '1970-01-01T00:00:00.000Z';

/** 基准规则默认负载：用于承接无规则时期的旧台账 */
function defaultBaselinePayload() {
  return {
    categories: [
      { code: 'LITTER', name: '暴露垃圾', base_score: 1, rectify_days: 5 },
      { code: 'POSTER', name: '违规张贴', base_score: 1, rectify_days: 3 },
      { code: 'STALL', name: '占道经营', base_score: 2, rectify_days: 3 },
      { code: 'OTHER', name: '其他市容问题', base_score: 1, rectify_days: 5 },
    ],
    ladder: [
      { level: 1, overdue_days: 0, action: '警告', penalty_points: 0 },
      { level: 2, overdue_days: 5, action: '罚款', penalty_points: 3 },
      { level: 3, overdue_days: 10, action: '约谈', penalty_points: 6 },
    ],
  };
}

/**
 * 模型迁移（可重复执行，幂等）：
 * 1. 查找或创建基准规则（baseline，直接生效，作为旧数据的规则归属）；
 * 2. 对所有缺少规则快照的立案冻结基准快照与计算依据；
 * 3. 既有照片、整改、合同归属一律原样保留，可直接回归。
 */
function runBaselineMigration(store, idx, clock, { payload = null } = {}) {
  return store.tx(() => {
    const now = clock.now().toISOString();
    let baseline = store.all('rules').find((r) => r.baseline === true) || null;
    let baselineCreated = false;
    if (!baseline) {
      baseline = {
        id: store.nextId('rule'),
        code: BASELINE_RULE_CODE,
        version: 1,
        status: 'EFFECTIVE',
        retroactive: false,
        baseline: true,
        effective_from: BASELINE_EFFECTIVE_FROM,
        effective_to: null,
        payload: payload || defaultBaselinePayload(),
        note: '模型迁移基准规则：承接迁移前旧台账',
        created_at: now,
        updated_at: now,
        validated_at: now,
        published_at: now,
        withdrawn_at: null,
        superseded_by: null,
      };
      store.assertUnique(idx.ruleCodeVersion, baseline);
      store.insert('rules', baseline);
      baselineCreated = true;
    }

    const migrated = [];
    for (const c of store.where('cases', (c) => !c.rule_version_id || !c.rule_snapshot)) {
      c.rule_version_id = baseline.id;
      c.rule_snapshot = snapshotOf(baseline);
      c.calc_basis = {
        resolved_at: now,
        resolution: 'BASELINE_MIGRATION',
        rule: { id: baseline.id, code: baseline.code, version: baseline.version },
        category: c.category,
        base_score: null,
        rectify_days: null,
        deadline: c.deadline, // 旧台账既有整改期限原样保留
        migrated: true,
      };
      c.migrated_at = now;
      migrated.push(c.id);
    }

    return {
      baseline_rule_id: baseline.id,
      baseline_created: baselineCreated,
      migrated_count: migrated.length,
      migrated_case_ids: migrated,
      migrated_at: now,
    };
  });
}

module.exports = { runBaselineMigration, defaultBaselinePayload, BASELINE_RULE_CODE };
