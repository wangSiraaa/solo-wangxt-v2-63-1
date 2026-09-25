'use strict';

/** 规则生命周期状态机与按事件时间解析的单元测试 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store, buildIndexes } = require('../src/store');
const { manualClock } = require('../src/clock');
const {
  createRule,
  validateRule,
  publishRule,
  withdrawRule,
  resolveRule,
  validatePayload,
} = require('../src/rules');
const { validPayload } = require('./helpers');

function setup(startIso = '2026-01-01T00:00:00.000Z') {
  const store = new Store();
  const idx = buildIndexes(store);
  const clock = manualClock(startIso);
  return { store, idx, clock };
}

function makeRule(store, idx, clock, { version, from, to = null, payload = validPayload() }) {
  const r = createRule(store, idx, clock, {
    code: 'city-appearance-standard',
    version,
    effective_from: from,
    effective_to: to,
    payload,
  });
  validateRule(store, idx, clock, r.id);
  return r;
}

test('状态机：DRAFT → VALIDATED → EFFECTIVE → SUPERSEDED；WITHDRAWN 终态', () => {
  const { store, idx, clock } = setup();
  const r1 = makeRule(store, idx, clock, { version: 1, from: '2026-01-01T00:00:00.000Z' });
  assert.equal(r1.status, 'VALIDATED');

  // 非法跃迁：VALIDATED → VALIDATED 允许（幂等复核），DRAFT 直接发布不允许
  const draft = createRule(store, idx, clock, {
    code: 'city-appearance-standard',
    version: 9,
    effective_from: '2027-01-01T00:00:00.000Z',
    payload: validPayload(),
  });
  assert.throws(() => publishRule(store, idx, clock, draft.id), /不允许发布/);

  publishRule(store, idx, clock, r1.id);
  assert.equal(store.get('rules', r1.id).status, 'EFFECTIVE');

  // 新版本顺延替代
  const r2 = makeRule(store, idx, clock, { version: 2, from: '2026-03-01T00:00:00.000Z' });
  publishRule(store, idx, clock, r2.id);
  assert.equal(store.get('rules', r1.id).status, 'SUPERSEDED');
  assert.equal(store.get('rules', r1.id).effective_to, '2026-03-01T00:00:00.000Z');
  assert.equal(store.get('rules', r1.id).superseded_by, r2.id);

  // 撤回终态
  withdrawRule(store, idx, clock, r2.id);
  assert.equal(store.get('rules', r2.id).status, 'WITHDRAWN');
  assert.throws(() => withdrawRule(store, idx, clock, r2.id), /已撤回/);
  assert.throws(() => publishRule(store, idx, clock, r2.id), /不允许发布/);
});

test('按事件发生时间解析：左闭右开窗口，已替代版本仍解析历史事件', () => {
  const { store, idx, clock } = setup();
  const r1 = makeRule(store, idx, clock, {
    version: 1,
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-03-01T00:00:00.000Z',
  });
  const r2 = makeRule(store, idx, clock, { version: 2, from: '2026-03-01T00:00:00.000Z' });
  publishRule(store, idx, clock, r1.id);
  publishRule(store, idx, clock, r2.id);

  assert.equal(resolveRule(store, 'city-appearance-standard', '2026-02-15T00:00:00.000Z').id, r1.id);
  // 右开：恰好等于 effective_to 的事件落到下一版本
  assert.equal(resolveRule(store, 'city-appearance-standard', '2026-03-01T00:00:00.000Z').id, r2.id);
  // 窗口之前无规则
  assert.equal(resolveRule(store, 'city-appearance-standard', '2025-12-31T23:59:59.000Z'), null);
});

test('负载校验：无效阶梯与非法类别逐项报错', () => {
  const cases = [
    [{ categories: [], ladder: validPayload().ladder }, '类别清单不能为空'],
    [
      {
        categories: [
          { code: 'A', name: '甲', base_score: 1, rectify_days: 1 },
          { code: 'A', name: '乙', base_score: 1, rectify_days: 1 },
        ],
        ladder: validPayload().ladder,
      },
      '类别编码重复',
    ],
    [
      {
        categories: [{ code: 'A', name: '甲', base_score: -1, rectify_days: 1 }],
        ladder: validPayload().ladder,
      },
      '基准分值',
    ],
    [
      {
        categories: [{ code: 'A', name: '甲', base_score: 1, rectify_days: 0 }],
        ladder: validPayload().ladder,
      },
      '整改时限',
    ],
    [{ categories: validPayload().categories, ladder: [] }, '升级阶梯不能为空'],
    [
      {
        categories: validPayload().categories,
        ladder: [
          { level: 1, overdue_days: 5, action: '警告', penalty_points: 0 },
          { level: 2, overdue_days: 5, action: '罚款', penalty_points: 1 },
        ],
      },
      '严格递增',
    ],
    [
      {
        categories: validPayload().categories,
        ladder: [
          { level: 1, overdue_days: 0, action: '警告', penalty_points: 0 },
          { level: 1, overdue_days: 3, action: '罚款', penalty_points: 1 },
        ],
      },
      '级别重复',
    ],
    [
      {
        categories: validPayload().categories,
        ladder: [{ level: 1, overdue_days: 0, action: '警告', penalty_points: -2 }],
      },
      '处罚分值',
    ],
  ];
  for (const [payload, fragment] of cases) {
    const errors = validatePayload(payload);
    assert.ok(errors.length > 0, `应当报错: ${fragment}`);
    assert.ok(
      errors.some((e) => e.message.includes(fragment)),
      `错误信息应包含「${fragment}」，实际: ${JSON.stringify(errors)}`
    );
  }
  assert.deepEqual(validatePayload(validPayload()), []);
});

test('校验失败不改变状态；重复校验幂等', () => {
  const { store, idx, clock } = setup();
  const r = createRule(store, idx, clock, {
    code: 'city-appearance-standard',
    version: 1,
    effective_from: '2026-01-01T00:00:00.000Z',
    payload: { categories: [], ladder: [] },
  });
  assert.throws(() => validateRule(store, idx, clock, r.id), /校验未通过/);
  assert.equal(store.get('rules', r.id).status, 'DRAFT');

  store.get('rules', r.id).payload = validPayload();
  validateRule(store, idx, clock, r.id);
  validateRule(store, idx, clock, r.id); // 幂等
  assert.equal(store.get('rules', r.id).status, 'VALIDATED');
});
