'use strict';

/**
 * 验收测试：对应任务验收标准五条。
 * A. 未来规则不影响旧事件
 * B. 回填规则命中锁定处罚时保留原版并追加处理链
 * C. 重复发布或并发升级不产生双记录
 * D. 时间窗重叠、无效阶梯或试算失败时原台账完整保留
 * E. 旧数据迁移为基准规则后既有照片、整改和合同归属可直接回归
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validPayload,
  startApp,
  makePublishedRule,
  snapshotStore,
  assertStoreEquals,
} = require('./helpers');

test('A. 未来规则不影响旧事件：按事件发生时间解析，升级只读冻结快照', async () => {
  const { api, clock, close } = await startApp('2026-01-01T00:00:00.000Z');
  try {
    // v1：2026-01-01 起生效，L2=5 分 / L3=10 分
    const v1 = await makePublishedRule(api, {
      code: 'city-appearance-standard',
      version: 1,
      effective_from: '2026-01-01T00:00:00.000Z',
      payload: validPayload(),
    });
    assert.equal(v1.rule.status, 'EFFECTIVE');

    // 旧事件立案：2026-02-01，冻结 v1 快照
    const c1 = await api('POST', '/api/cases', {
      event_time: '2026-02-01T08:00:00.000Z',
      category: 'LITTER',
      description: '主干道暴露垃圾',
    });
    assert.equal(c1.status, 201);
    assert.equal(c1.body.rule_version_id, v1.rule.id);
    assert.equal(c1.body.calc_basis.resolution, 'EVENT_TIME_WINDOW');
    assert.equal(c1.body.deadline, '2026-02-04T08:00:00.000Z');

    // v2：未来生效（2026-03-01），L2 改为 99 分；v1 被顺延替代
    const v2Payload = validPayload();
    v2Payload.ladder[1].penalty_points = 99;
    const v2 = await makePublishedRule(api, {
      code: 'city-appearance-standard',
      version: 2,
      effective_from: '2026-03-01T00:00:00.000Z',
      payload: v2Payload,
    });
    const v1After = await api('GET', `/api/rules/${v1.rule.id}`);
    assert.equal(v1After.body.status, 'SUPERSEDED');
    assert.equal(v1After.body.effective_to, '2026-03-01T00:00:00.000Z');

    // 旧事件（2026-02-15，早于 v2 窗口）仍解析到 v1
    const c2 = await api('POST', '/api/cases', {
      event_time: '2026-02-15T08:00:00.000Z',
      category: 'LITTER',
    });
    assert.equal(c2.body.rule_version_id, v1.rule.id);

    // 新事件（2026-03-05）解析到 v2
    const c3 = await api('POST', '/api/cases', {
      event_time: '2026-03-05T00:00:00.000Z',
      category: 'LITTER',
    });
    assert.equal(c3.body.rule_version_id, v2.rule.id);

    // 时钟推进到 v2 生效之后：旧案升级仍按 v1 快照阶梯，不被新规则静默重算
    clock.set('2026-03-10T00:00:00.000Z');
    const run = await api('POST', '/api/escalations/run', {});
    assert.equal(run.status, 200);
    const c1Esc = run.body.created.filter((e) => e.case_id === c1.body.id);
    assert.deepEqual(c1Esc.map((e) => e.level), [1, 2, 3]);

    const detail = await api('GET', `/api/cases/${c1.body.id}`);
    const amounts = detail.body.penalties.map((p) => p.amount).sort((a, b) => a - b);
    assert.deepEqual(amounts, [5, 10], '旧案处罚必须按 v1 快照金额，不得出现 v2 的 99 分');
    for (const p of detail.body.penalties) {
      const pd = await api('GET', `/api/penalties/${p.id}`);
      assert.equal(pd.body.rule_chain[0].kind, 'RULE_SNAPSHOT');
      assert.equal(pd.body.rule_chain[0].ref_id, v1.rule.id);
    }
  } finally {
    await close();
  }
});

test('B. 回填规则命中锁定处罚：保留原版，确认后追加更正与复核处理链', async () => {
  const { api, clock, close } = await startApp('2026-01-01T00:00:00.000Z');
  try {
    const v1 = await makePublishedRule(api, {
      code: 'city-appearance-standard',
      version: 1,
      effective_from: '2026-01-01T00:00:00.000Z',
      payload: validPayload(),
    });
    const c1 = await api('POST', '/api/cases', {
      event_time: '2026-02-01T00:00:00.000Z',
      category: 'LITTER',
    });
    // 逾期 6 天 → L1(0 分) + L2(5 分)
    clock.set('2026-02-10T00:00:00.000Z');
    await api('POST', '/api/escalations/run', {});
    let detail = await api('GET', `/api/cases/${c1.body.id}`);
    assert.equal(detail.body.penalties.length, 1);
    const penaltyId = detail.body.penalties[0].id;
    assert.equal(detail.body.penalties[0].amount, 5);

    // 锁定处罚
    const locked = await api('POST', `/api/penalties/${penaltyId}/lock`);
    assert.equal(locked.body.penalty.status, 'LOCKED');

    // 回填规则：追溯生效（effective_from 早于当前时钟），L2 改为 9 分
    const retroPayload = validPayload();
    retroPayload.ladder[1].penalty_points = 9;
    const retro = await makePublishedRule(api, {
      code: 'city-appearance-standard',
      version: 2,
      effective_from: '2026-01-15T00:00:00.000Z',
      payload: retroPayload,
    });
    assert.equal(retro.rule.retroactive, true, '追溯发布必须标记 retroactive');
    assert.equal(retro.impacts.length, 1, '追溯发布只生成影响清单');
    assert.equal(retro.impacts[0].kind, 'WOULD_CHANGE_PENALTY');
    assert.equal(retro.impacts[0].detail.before_amount, 5);
    assert.equal(retro.impacts[0].detail.after_amount, 9);

    // 原处罚未被覆盖
    let pd = await api('GET', `/api/penalties/${penaltyId}`);
    assert.equal(pd.body.amount, 5);
    assert.equal(pd.body.status, 'LOCKED');

    // 确认影响项 → 追加更正与复核
    const impactId = retro.impacts[0].id;
    const confirmed = await api('POST', `/api/impacts/${impactId}/confirm`, {
      operator: '审核员甲',
    });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.correction.delta, 4);
    assert.equal(confirmed.body.review.result, 'CONFIRMED');

    // 处理链追加，但原处罚金额仍保留
    pd = await api('GET', `/api/penalties/${penaltyId}`);
    assert.equal(pd.body.amount, 5, '锁定处罚不得覆盖');
    assert.equal(pd.body.corrections_total, 4);
    const kinds = pd.body.rule_chain.map((e) => e.kind);
    assert.deepEqual(kinds, ['RULE_SNAPSHOT', 'ESCALATION', 'LOCK', 'CORRECTION', 'REVIEW']);

    // 重复确认幂等：不产生第二条更正
    const again = await api('POST', `/api/impacts/${impactId}/confirm`, {});
    assert.equal(again.body.idempotent, true);
    assert.equal(again.body.correction.id, confirmed.body.correction.id);
    const pd2 = await api('GET', `/api/penalties/${penaltyId}`);
    assert.equal(pd2.body.rule_chain.length, pd.body.rule_chain.length);

    // 追溯规则不参与解析：窗口内新立案仍命中 v1
    const c2 = await api('POST', '/api/cases', {
      event_time: '2026-02-05T00:00:00.000Z',
      category: 'LITTER',
    });
    assert.equal(c2.body.rule_version_id, v1.rule.id);
  } finally {
    await close();
  }
});

test('C. 重复发布与并发升级不产生双记录', async () => {
  const { api, clock, app, close } = await startApp('2026-01-01T00:00:00.000Z');
  try {
    const input = {
      code: 'city-appearance-standard',
      version: 1,
      effective_from: '2026-01-01T00:00:00.000Z',
      payload: validPayload(),
    };
    const created = await api('POST', '/api/rules', input);
    assert.equal(created.status, 201);
    // 同代码同版本重复建档 → 409，不产生第二条
    const dup = await api('POST', '/api/rules', input);
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'DUPLICATE_RECORD');

    await api('POST', `/api/rules/${created.body.id}/validate`);
    const p1 = await api('POST', `/api/rules/${created.body.id}/publish`);
    const p2 = await api('POST', `/api/rules/${created.body.id}/publish`);
    assert.equal(p1.body.idempotent, false);
    assert.equal(p2.body.idempotent, true, '重复发布幂等返回原记录');
    assert.equal(p2.body.rule.id, p1.body.rule.id);
    const all = await api('GET', '/api/rules?status=EFFECTIVE');
    assert.equal(all.body.data.length, 1);

    // 立案并逾期 20 天
    const c1 = await api('POST', '/api/cases', {
      event_time: '2026-01-01T00:00:00.000Z',
      category: 'LITTER',
    });
    clock.advanceDays(20);

    // 并发触发升级 5 次（升级核心为同步临界区 + 唯一索引兜底）
    const runs = await Promise.all(
      Array.from({ length: 5 }, () => api('POST', '/api/escalations/run', {}))
    );
    const totalCreated = runs.reduce((sum, r) => sum + r.body.created.length, 0);
    assert.equal(totalCreated, 3, '并发下三级阶梯只应各产生一条升级记录');
    const detail = await api('GET', `/api/cases/${c1.body.id}`);
    assert.equal(detail.body.escalations.length, 3);
    assert.equal(detail.body.penalties.length, 2, 'L2/L3 各一条处罚，无双记录');

    // 再次顺序运行为空转
    const again = await api('POST', '/api/escalations/run', {});
    assert.equal(again.body.created.length, 0);
    assert.equal(app.store.all('escalations').length, 3);
  } finally {
    await close();
  }
});

test('D. 时间窗重叠、无效阶梯、试算失败：原台账完整保留', async () => {
  const { api, app, close } = await startApp('2026-01-01T00:00:00.000Z');
  try {
    const v1 = await makePublishedRule(api, {
      code: 'city-appearance-standard',
      version: 1,
      effective_from: '2026-01-01T00:00:00.000Z',
      payload: validPayload(),
    });

    // 1) 有界窗口与开口的 v1 重叠 → 409，台账不变
    const v2 = await api('POST', '/api/rules', {
      code: 'city-appearance-standard',
      version: 2,
      effective_from: '2026-06-01T00:00:00.000Z',
      effective_to: '2026-09-01T00:00:00.000Z',
      payload: validPayload(),
    });
    assert.equal(v2.status, 201);
    await api('POST', `/api/rules/${v2.body.id}/validate`);
    const snap1 = snapshotStore(app.store);
    const overlap = await api('POST', `/api/rules/${v2.body.id}/publish`);
    assert.equal(overlap.status, 409);
    assert.equal(overlap.body.error.code, 'RULE_WINDOW_OVERLAP');
    assertStoreEquals(app.store, snap1, '重叠发布失败后台账必须完整保留');
    assert.equal((await api('GET', `/api/rules/${v1.rule.id}`)).body.status, 'EFFECTIVE');
    assert.equal((await api('GET', `/api/rules/${v2.body.id}`)).body.status, 'VALIDATED');

    // 2) 无效阶梯：逾期阈值未随级别递增 → 校验 422，状态停留 DRAFT
    const badLadder = validPayload({
      ladder: [
        { level: 1, overdue_days: 3, action: '警告', penalty_points: 0 },
        { level: 2, overdue_days: 1, action: '罚款', penalty_points: 5 },
      ],
    });
    const v3 = await api('POST', '/api/rules', {
      code: 'city-appearance-standard',
      version: 3,
      effective_from: '2027-01-01T00:00:00.000Z',
      payload: badLadder,
    });
    assert.equal(v3.status, 201);
    const snap2 = snapshotStore(app.store);
    const invalid = await api('POST', `/api/rules/${v3.body.id}/validate`);
    assert.equal(invalid.status, 422);
    assert.equal(invalid.body.error.code, 'RULE_VALIDATION_FAILED');
    assertStoreEquals(app.store, snap2, '校验失败后台账必须完整保留');
    assert.equal((await api('GET', `/api/rules/${v3.body.id}`)).body.status, 'DRAFT');

    // 3) 试算失败（负载非法）→ 422，台账不变；试算成功也不落库
    const snap3 = snapshotStore(app.store);
    const trialBad = await api('POST', `/api/rules/${v3.body.id}/trial`, {
      events: [{ event_time: '2027-01-02T00:00:00.000Z', category: 'LITTER', overdue_days: 5 }],
    });
    assert.equal(trialBad.status, 422);
    assert.equal(trialBad.body.error.code, 'RULE_PAYLOAD_INVALID');
    assertStoreEquals(app.store, snap3, '试算失败后台账必须完整保留');

    const trialOk = await api('POST', `/api/rules/${v1.rule.id}/trial`, {
      events: [
        { event_time: '2026-02-01T00:00:00.000Z', category: 'LITTER', overdue_days: 5 },
        { event_time: '2026-02-01T00:00:00.000Z', category: 'NOPE' },
      ],
    });
    assert.equal(trialOk.status, 200);
    assert.equal(trialOk.body.persisted, false);
    assert.equal(trialOk.body.results[0].ok, true);
    assert.equal(trialOk.body.results[0].total_penalty_points, 5);
    assert.equal(trialOk.body.results[1].ok, false);
    assert.equal(trialOk.body.results[1].error.code, 'UNKNOWN_CATEGORY');
    assert.equal(app.store.all('cases').length, 0, '试算不得产生立案');
    assert.equal(app.store.all('escalations').length, 0, '试算不得产生升级');

    // 4) 非法时间窗建稿 → 422
    const badWindow = await api('POST', '/api/rules', {
      code: 'city-appearance-standard',
      version: 9,
      effective_from: '2026-09-01T00:00:00.000Z',
      effective_to: '2026-06-01T00:00:00.000Z',
      payload: validPayload(),
    });
    assert.equal(badWindow.status, 422);
    assert.equal(badWindow.body.error.code, 'RULE_WINDOW_INVALID');
  } finally {
    await close();
  }
});

test('E. 旧数据迁移为基准规则后，照片、整改与合同归属可直接回归', async () => {
  const { api, app, clock, close } = await startApp('2026-06-01T00:00:00.000Z');
  try {
    // 模拟迁移前旧台账：无规则快照的立案 + 照片 + 整改 + 合同归属
    const contract = await api('POST', '/api/contracts', {
      name: '城东保洁合同',
      contractor: '某某环境公司',
    });
    const legacyId = app.store.nextId('case');
    app.store.insert('cases', {
      id: legacyId,
      case_no: 'AJ-LEGACY-1',
      event_time: '2025-12-01T00:00:00.000Z',
      category: 'LITTER',
      description: '迁移前旧案',
      reporter: '巡查员',
      contract_id: contract.body.id,
      status: 'FILED',
      rule_version_id: null,
      rule_snapshot: null,
      calc_basis: null,
      deadline: '2025-12-06T00:00:00.000Z',
      rectified_at: null,
      created_at: '2025-12-01T01:00:00.000Z',
    });
    app.store.insert('rectifications', {
      id: app.store.nextId('rect'),
      case_id: legacyId,
      deadline: '2025-12-06T00:00:00.000Z',
      status: 'PENDING',
      submitted_at: null,
      late: null,
      note: null,
    });
    await api('POST', `/api/cases/${legacyId}/photos`, {
      url: 'oss://photos/legacy-1.jpg',
      kind: 'EVIDENCE',
    });
    await api('POST', `/api/cases/${legacyId}/photos`, {
      url: 'oss://photos/legacy-2.jpg',
      kind: 'RECTIFICATION',
    });

    // 迁移：旧数据挂接基准规则
    const mig = await api('POST', '/api/migrations/baseline', {});
    assert.equal(mig.status, 200);
    assert.equal(mig.body.baseline_created, true);
    assert.equal(mig.body.migrated_count, 1);

    // 回归：照片、整改、合同归属原样保留；快照为基准规则
    const detail = await api('GET', `/api/cases/${legacyId}`);
    assert.equal(detail.body.rule_snapshot.code, 'baseline-legacy');
    assert.equal(detail.body.rule_snapshot.baseline, true);
    assert.equal(detail.body.calc_basis.resolution, 'BASELINE_MIGRATION');
    assert.equal(detail.body.photos.length, 2, '既有照片必须保留');
    assert.equal(detail.body.rectification.deadline, '2025-12-06T00:00:00.000Z', '既有整改期限保留');
    assert.equal(detail.body.contract.id, contract.body.id, '合同归属保留');

    // 迁移后旧案可按基准快照升级（可注入时钟）
    clock.set('2026-06-20T00:00:00.000Z');
    const run = await api('POST', '/api/escalations/run', {});
    const legacyEsc = run.body.created.filter((e) => e.case_id === legacyId);
    assert.deepEqual(legacyEsc.map((e) => e.level), [1, 2, 3], '迁移后按基准阶梯升级');

    // 幂等：重复迁移不再产生新记录
    const mig2 = await api('POST', '/api/migrations/baseline', {});
    assert.equal(mig2.body.baseline_created, false);
    assert.equal(mig2.body.migrated_count, 0);
    assert.equal(mig2.body.baseline_rule_id, mig.body.baseline_rule_id);

    // 迁移后新立案（无常规规则覆盖的旧事件）回退基准规则
    const c2 = await api('POST', '/api/cases', {
      event_time: '2025-11-01T00:00:00.000Z',
      category: 'OTHER',
    });
    assert.equal(c2.status, 201);
    assert.equal(c2.body.rule_snapshot.baseline, true);
  } finally {
    await close();
  }
});
