import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Harness } from './helpers.ts';
import { makeApp, publishRule, seedCategory, LADDER_STD, LADDER_STRICT, count } from './helpers.ts';

/**
 * 验收 1：未来规则不影响旧事件；立案快照冻结；后续升级仍按快照计算。
 */
describe('未来规则不影响旧事件 + 快照冻结升级', () => {
  let h: Harness;

  before(async () => {
    h = await makeApp();
  });

  test('完整时序', async () => {
    const { app, clock, db } = h;
    await seedCategory(app, 'WGT', '违规占道');

    // 时点：2026-03-01。发布一条【常规】基准规则，立即生效。
    clock.setNow('2026-03-01T00:00:00.000Z');
    const r1 = await publishRule(app, { category_code: 'WGT', content: LADDER_STD });
    assert.equal(r1.status, 200);
    const stdId = r1.body.rule.id;

    // 发布【未来规则】：2026-06-01 才生效，整改时限更严。
    clock.setNow('2026-03-02T00:00:00.000Z');
    const r2 = await publishRule(app, {
      category_code: 'WGT',
      effective_from: '2026-06-01T00:00:00.000Z',
      content: LADDER_STRICT,
    });
    assert.equal(r2.status, 200);
    const futureId = r2.body.rule.id;
    assert.deepEqual(r2.body.superseded_version_ids, [stdId], '发布时截断前驱窗口到 6 月 1 日');

    // 3 月立案的旧事件（发生于 3 月 10 日）。
    clock.setNow('2026-03-10T01:00:00.000Z');
    const fileRes = await app.inject({
      method: 'POST',
      url: '/cases',
      payload: {
        category_code: 'WGT',
        occurred_at: '2026-03-10T00:00:00.000Z',
        location: '测试路 1 号',
      },
    });
    assert.equal(fileRes.statusCode, 200);
    const oldCase = JSON.parse(fileRes.body);
    assert.equal(oldCase.rule_version_id, stdId, '旧事件必须命中旧规则而非未来规则');
    assert.equal(oldCase.rule_snapshot.rectify_hours, 24);
    assert.equal(oldCase.calc_basis.resolved_by, 'event_occurred_at');

    // 6 月之后未来规则已生效，旧案件升级仍必须按 24h 快照。
    // 事件 +24h 到 3 月 11 日就应触发 step1；若被静默重算成 12h，step 触发点会漂移。
    const sweep = await app.inject({
      method: 'POST',
      url: '/escalations/run',
      payload: { case_id: oldCase.id, at: '2026-06-05T00:00:00.000Z' },
    });
    assert.equal(sweep.statusCode, 200);
    const swept = JSON.parse(sweep.body);
    const steps = swept.escalated.map((e: { step: number }) => e.step).sort();
    assert.deepEqual(steps, [1, 2], '按旧快照：逾期 61 天 >= 72h 触发 1、2 阶');
    assert.ok(
      swept.escalated.every((e: { due_at: string }) =>
        e.due_at.startsWith('2026-03'),
      ),
      'due_at 依据旧事件时间 + 旧时限计算',
    );

    // 升级记录引用的规则版本仍是 stdId，而非未来版本。
    assert.equal(
      count(db, `SELECT COUNT(*) FROM escalations WHERE case_id=${oldCase.id} AND rule_version_id=${stdId}`),
      2,
    );
    assert.equal(
      count(db, `SELECT COUNT(*) FROM escalations WHERE case_id=${oldCase.id} AND rule_version_id=${futureId}`),
      0,
      '新规则绝不参与旧案件升级',
    );

    // 6 月之后的新事件必须命中未来规则。
    const newCaseRes = await app.inject({
      method: 'POST',
      url: '/cases',
      payload: {
        category_code: 'WGT',
        occurred_at: '2026-06-10T00:00:00.000Z',
        location: '测试路 2 号',
      },
    });
    assert.equal(newCaseRes.statusCode, 200);
    const newCase = JSON.parse(newCaseRes.body);
    assert.equal(newCase.rule_version_id, futureId, '新事件命中未来规则');
    assert.equal(newCase.rule_snapshot.rectify_hours, 12);

    // 案件详情中的快照与规则链一致。
    const detail = JSON.parse((await app.inject({ url: `/cases/${oldCase.id}` })).body);
    assert.equal(detail.penalty_chain.length, 3, '立案 1 条 + 升级 2 条原始处罚');
    assert.ok(detail.penalty_chain.every((e: { rule_version_id: number }) => e.rule_version_id === stdId));
  });
});
