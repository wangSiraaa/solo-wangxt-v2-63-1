import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Harness } from './helpers.ts';
import { makeApp, publishRule, seedCategory, LADDER_STD, count } from './helpers.ts';

/**
 * 验收 4：时间窗重叠、无效阶梯或试算失败时，原台账完整保留。
 */
describe('失败路径：重叠窗口 / 无效阶梯 / 试算失败均不破坏台账', () => {
  let h: Harness;
  before(async () => {
    h = await makeApp();
  });

  test('无效阶梯被拒且不产生有效规则', async () => {
    const { app, clock, db } = h;
    await seedCategory(app, 'BAD', '坏阶梯类别');
    clock.setNow('2026-03-01T00:00:00.000Z');

    const bad = {
      category_code: 'BAD',
      base_score: 2,
      base_fine: 200,
      rectify_hours: 24,
      ladder: [
        { step: 0, after_hours: 0, score: 2, fine: 200, action: '改正' },
        // 无效：after_hours 没有严格递增
        { step: 1, after_hours: 0, score: 5, fine: 500, action: '加重' },
      ],
    };
    const draft = await app.inject({
      method: 'POST',
      url: '/rules/drafts',
      payload: { category_code: 'BAD', content: bad },
    });
    assert.equal(draft.statusCode, 200, '半成品允许作为草稿存在');
    const { id } = JSON.parse(draft.body);

    const val = await app.inject({ method: 'POST', url: `/rules/${id}/validate` });
    assert.equal(val.statusCode, 422);
    assert.match(JSON.parse(val.body).error.message, /必须大于上一档|阶梯无效/);

    // 未校验通过直接发布必须被拒。
    const pub = await app.inject({ method: 'POST', url: `/rules/${id}/publish` });
    assert.equal(pub.statusCode, 409);

    // 台账里没有 BAD 类别的有效规则，立案解析必须失败而非使用坏内容。
    const file = await app.inject({
      method: 'POST',
      url: '/cases',
      payload: { category_code: 'BAD', occurred_at: '2026-03-02T00:00:00.000Z', location: 'x' },
    });
    assert.equal(file.statusCode, 409);
    assert.equal(JSON.parse(file.body).error.code, 'RULE_NO_MATCH');
    assert.equal(count(db, `SELECT COUNT(*) FROM cases WHERE category_code='BAD'`), 0);
  });

  test('时间窗重叠发布被拒，既有规则窗口保持不变', async () => {
    const { app, clock, db } = h;
    await seedCategory(app, 'OVL', '重叠类别');
    clock.setNow('2026-01-01T00:00:00.000Z');
    const r1 = await publishRule(app, {
      category_code: 'OVL',
      content: { ...LADDER_STD, category_code: 'OVL' },
    });
    assert.equal(r1.status, 200);
    const firstId = r1.body.rule.id;

    // 构造“多于一条重叠窗口”的脏状态：手工把一条 superseded 行恢复成与当前窗口重叠。
    await db.serialTxn((tx) => {
      tx.run(
        `INSERT INTO rule_versions
           (rule_code, version_no, category_code, status, effective_from, effective_to,
            is_retroactive, content_json, content_sha256, validated_at, published_at, created_at)
         VALUES ('STD_OVL', 5, 'OVL', 'effective', NULL, NULL, 0, ?, 'x1', 't', 't', 't')`,
        [
          JSON.stringify({ ...LADDER_STD, category_code: 'OVL', base_fine: 999 }),
        ],
      );
    });

    const r3 = await publishRule(app, {
      category_code: 'OVL',
      effective_from: '2026-06-01T00:00:00.000Z',
      content: (() => {
        const c = { ...LADDER_STD, category_code: 'OVL', base_fine: 777, base_score: 2,
          ladder: LADDER_STD.ladder.map((t) => ({ ...t, fine: t.step === 0 ? 777 : t.fine })) };
        return c;
      })(),
    });
    // 手工脏窗口下应检测到多重重叠而拒绝（422），原台账不变。
    assert.equal(r3.status, 422);
    assert.match(r3.body.error.message, /时间窗重叠/);

    // 原首条规则仍 effective 且右开；无任何案件被改。
    const first = JSON.parse(
      (await app.inject({ url: `/rules/${firstId}` })).body,
    );
    assert.equal(first.status, 'effective');
    assert.equal(first.effective_to, null);
    assert.equal(count(db, `SELECT COUNT(*) FROM cases WHERE category_code='OVL'`), 0);
  });

  test('发布更早规则与已排期未来规则交叉时被拒', async () => {
    const fresh = await makeApp();
    const app = fresh.app;
    const clock = fresh.clock;
    const db = fresh.db;
    await seedCategory(app, 'FUT', '未来重叠类别');
    clock.setNow('2026-01-01T00:00:00.000Z');
    clock.setNow('2026-01-01T00:00:00.000Z');
    const first = await publishRule(app, {
      category_code: 'FUT',
      content: { ...LADDER_STD, category_code: 'FUT' },
    });
    assert.equal(first.status, 200);

    // 先排期一条 2026-06-01 生效的未来规则。
    const future = await publishRule(app, {
      category_code: 'FUT',
      effective_from: '2026-06-01T00:00:00.000Z',
      content: (() => {
        const c = {
          ...LADDER_STD,
          category_code: 'FUT',
          base_fine: 500,
          ladder: LADDER_STD.ladder.map((t) => ({ ...t, fine: t.step === 0 ? 500 : t.fine })),
        };
        return c;
      })(),
    });
    assert.equal(future.status, 200);

    // 再发布一条 2026-03-01 生效、内容不同的规则：会与未来规则交叉，必须 422。
    const crossing = await publishRule(app, {
      category_code: 'FUT',
      effective_from: '2026-03-01T00:00:00.000Z',
      content: (() => {
        const c = {
          ...LADDER_STD,
          category_code: 'FUT',
          base_fine: 350,
          ladder: LADDER_STD.ladder.map((t) => ({ ...t, fine: t.step === 0 ? 350 : t.fine })),
        };
        return c;
      })(),
    });
    assert.equal(crossing.status, 422);
    assert.match(crossing.body.error.message, /未来规则/);
    // 被拒规则只能停留在 validated 草稿态；有效规则集仍只有原未来规则一条，
    // 首条规则保持 superseded（窗口被未来规则截断到 6 月 1 日）。
    assert.equal(
      count(db, `SELECT COUNT(*) FROM rule_versions WHERE category_code='FUT' AND status='effective'`),
      1,
    );
    assert.equal(
      count(db, `SELECT COUNT(*) FROM rule_versions WHERE category_code='FUT' AND status='superseded'`),
      1,
    );
    const drafts = await app.inject({ url: `/rules?category=FUT&status=validated` });
    assert.equal(JSON.parse(drafts.body).versions.length, 1, '被拒发布保留为 validated 草稿');

    // 3 月旧事件解析不受影响：仍命中首条规则。
    const probe = JSON.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/cases',
          payload: { category_code: 'FUT', occurred_at: '2026-03-15T00:00:00.000Z', location: 'x' },
        })
      ).body,
    );
    assert.equal(probe.rule_version_id, first.body.rule.id);
  });

  test('试算失败不落任何数据，成功试算也只读', async () => {
    const { app, clock, db } = h;
    await seedCategory(app, 'TRL', '试算类别');
    clock.setNow('2026-03-01T00:00:00.000Z');

    const published = await publishRule(app, {
      category_code: 'TRL',
      content: { ...LADDER_STD, category_code: 'TRL' },
    });
    const ruleId = published.body.rule.id;

    const before = {
      cases: count(db, `SELECT COUNT(*) FROM cases`),
      esc: count(db, `SELECT COUNT(*) FROM escalations`),
      pen: count(db, `SELECT COUNT(*) FROM penalty_entries`),
    };

    // 非法事件时间 -> 422。
    const badTrial = await app.inject({
      method: 'POST',
      url: `/rules/${ruleId}/trial`,
      payload: { at: '2026-04-01T00:00:00.000Z', event_times: ['not-a-date'] },
    });
    assert.equal(badTrial.statusCode, 422);
    assert.equal(JSON.parse(badTrial.body).error.code, 'TRIAL_FAILED');

    // 成功试算：返回投影但无写入；旧规则 24h 时限下，事件后 48h 触发 step1。
    const okTrial = await app.inject({
      method: 'POST',
      url: `/rules/${ruleId}/trial`,
      payload: {
        at: '2026-03-05T00:00:00.000Z',
        event_times: ['2026-03-03T00:00:00.000Z'],
      },
    });
    assert.equal(okTrial.statusCode, 200);
    const projected = JSON.parse(okTrial.body).results[0];
    assert.equal(projected.projected_step, 1);
    assert.equal(projected.overdue_hours, 24);

    const after = {
      cases: count(db, `SELECT COUNT(*) FROM cases`),
      esc: count(db, `SELECT COUNT(*) FROM escalations`),
      pen: count(db, `SELECT COUNT(*) FROM penalty_entries`),
    };
    assert.deepEqual(after, before, '试算前后台账记录数完全一致');
  });
});
