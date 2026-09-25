'use strict';

/** 升级引擎与处罚锁定单元测试 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store, buildIndexes } = require('../src/store');
const { manualClock } = require('../src/clock');
const { createRule, validateRule, publishRule } = require('../src/rules');
const { fileCase, submitRectification } = require('../src/cases');
const { runEscalation } = require('../src/escalation');
const { lockPenalty, getPenaltyDetail } = require('../src/penalties');
const { validPayload } = require('./helpers');

function setup(startIso = '2026-01-01T00:00:00.000Z') {
  const store = new Store();
  const idx = buildIndexes(store);
  const clock = manualClock(startIso);
  const r = createRule(store, idx, clock, {
    code: 'city-appearance-standard',
    version: 1,
    effective_from: '2026-01-01T00:00:00.000Z',
    payload: validPayload(),
  });
  validateRule(store, idx, clock, r.id);
  publishRule(store, idx, clock, r.id);
  return { store, idx, clock, rule: store.get('rules', r.id) };
}

test('可注入时钟逐级升级：按逾期天数补齐阶梯，幂等空转', () => {
  const { store, idx, clock } = setup();
  const c = fileCase(store, idx, clock, {
    event_time: '2026-01-01T00:00:00.000Z',
    category: 'LITTER',
  });
  // 期限 2026-01-04；逾期 2 天 → 仅 L1（0 分，不产生处罚）
  clock.set('2026-01-06T00:00:00.000Z');
  let run = runEscalation(store, idx, clock);
  assert.deepEqual(run.created.map((e) => e.level), [1]);
  assert.equal(store.all('penalties').length, 0);

  // 逾期 5 天 → 补 L2（5 分）
  clock.set('2026-01-09T00:00:00.000Z');
  run = runEscalation(store, idx, clock);
  assert.deepEqual(run.created.map((e) => e.level), [2]);
  assert.equal(store.all('penalties').length, 1);
  assert.equal(store.all('penalties')[0].amount, 5);

  // 逾期 10 天 → 补 L3（10 分）；再运行为空转
  clock.set('2026-01-14T00:00:00.000Z');
  run = runEscalation(store, idx, clock);
  assert.deepEqual(run.created.map((e) => e.level), [3]);
  run = runEscalation(store, idx, clock);
  assert.equal(run.created.length, 0);
  assert.equal(store.all('escalations').length, 3);
  assert.equal(store.all('penalties').length, 2);

  // 案件状态
  assert.equal(store.get('cases', c.id).status, 'ESCALATING');
});

test('已整改案件不再升级；升级只读冻结快照，规则后续变更不影响', () => {
  const { store, idx, clock } = setup();
  const c1 = fileCase(store, idx, clock, {
    event_time: '2026-01-01T00:00:00.000Z',
    category: 'LITTER',
  });
  const c2 = fileCase(store, idx, clock, {
    event_time: '2026-01-01T00:00:00.000Z',
    category: 'LITTER',
  });
  // c2 立即整改
  submitRectification(store, idx, clock, c2.id, {});

  // 立案后规则被替换（v2 把 L2 改成 50 分）
  const v2Payload = validPayload();
  v2Payload.ladder[1].penalty_points = 50;
  const v2 = createRule(store, idx, clock, {
    code: 'city-appearance-standard',
    version: 2,
    effective_from: '2026-02-01T00:00:00.000Z',
    payload: v2Payload,
  });
  validateRule(store, idx, clock, v2.id);
  publishRule(store, idx, clock, v2.id);

  clock.set('2026-03-01T00:00:00.000Z'); // 两案均逾期，且 v2 已生效
  runEscalation(store, idx, clock);

  const esc1 = store.where('escalations', (e) => e.case_id === c1.id);
  const esc2 = store.where('escalations', (e) => e.case_id === c2.id);
  assert.equal(esc1.length, 3);
  assert.equal(esc2.length, 0, '已整改案件不再升级');
  const amounts = store
    .where('penalties', (p) => p.case_id === c1.id)
    .map((p) => p.amount)
    .sort((a, b) => a - b);
  assert.deepEqual(amounts, [5, 10], '必须按冻结快照金额，不得被 v2 静默重算');
});

test('处罚锁定幂等，规则链完整呈现', () => {
  const { store, idx, clock } = setup();
  const c = fileCase(store, idx, clock, {
    event_time: '2026-01-01T00:00:00.000Z',
    category: 'LITTER',
  });
  clock.set('2026-01-14T00:00:00.000Z');
  runEscalation(store, idx, clock);
  const pen = store.all('penalties')[0];

  const first = lockPenalty(store, clock, pen.id);
  assert.equal(first.penalty.status, 'LOCKED');
  const second = lockPenalty(store, clock, pen.id);
  assert.equal(second.idempotent, true);

  const detail = getPenaltyDetail(store, pen.id);
  assert.deepEqual(
    detail.rule_chain.map((e) => e.kind),
    ['RULE_SNAPSHOT', 'ESCALATION', 'LOCK']
  );
  assert.equal(detail.rule_chain[0].ref_id, c.rule_version_id);
  assert.equal(detail.amount, 5);
});
