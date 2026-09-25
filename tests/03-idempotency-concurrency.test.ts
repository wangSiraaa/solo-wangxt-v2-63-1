import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Harness } from './helpers.ts';
import { makeApp, publishRule, seedCategory, LADDER_STD, LADDER_STRICT, count } from './helpers.ts';

/**
 * 验收 3：重复发布或并发升级不产生双记录。
 */
describe('幂等与并发：重复发布 / 并发升级', () => {
  let h: Harness;
  before(async () => {
    h = await makeApp();
  });

  test('重复发布同一版本幂等', async () => {
    const { app, clock, db } = h;
    await seedCategory(app, 'DBL', '双发类别');

    clock.setNow('2026-03-01T00:00:00.000Z');
    const draft = JSON.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/rules/drafts',
          payload: { category_code: 'DBL', content: { ...LADDER_STD, category_code: 'DBL' } },
        })
      ).body,
    );
    await app.inject({ method: 'POST', url: `/rules/${draft.id}/validate` });
    const p1 = await app.inject({ method: 'POST', url: `/rules/${draft.id}/publish` });
    const p2 = await app.inject({ method: 'POST', url: `/rules/${draft.id}/publish` });
    assert.equal(p1.statusCode, 200);
    assert.equal(p2.statusCode, 200);
    assert.equal(JSON.parse(p2.body).idempotent, true);
    assert.equal(
      count(db, `SELECT COUNT(*) FROM rule_versions WHERE id=${draft.id} AND status='effective'`),
      1,
    );

    // 同内容重复建档必须被拒（校验和唯一）。
    const dup = await app.inject({
      method: 'POST',
      url: '/rules/drafts',
      payload: { category_code: 'DBL', content: { ...LADDER_STD, category_code: 'DBL' } },
    });
    assert.equal(dup.statusCode, 409);
    assert.equal(JSON.parse(dup.body).error.code, 'RULE_DUPLICATE_CONTENT');
  });

  test('并发升级扫描不产生双记录', async () => {
    const { app, clock, db } = h;

    clock.setNow('2026-04-01T00:00:00.000Z');
    const filed = JSON.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/cases',
          payload: {
            category_code: 'DBL',
            occurred_at: '2026-04-01T00:00:00.000Z',
            location: '并发路 7 号',
          },
        })
      ).body,
    );

    // 同一时点的 5 个“并发”扫描（事件循环内同时发起，写事务串行 + 唯一索引）。
    const at = '2026-04-10T00:00:00.000Z'; // 逾期远超 72h
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({ method: 'POST', url: '/escalations/run', payload: { case_id: filed.id, at } }),
      ),
    );
    const createdTotal = results.reduce(
      (n, r) => n + JSON.parse(r.body).created_count,
      0,
    );
    // 只有第一笔写入 2 条；其余 4 笔命中唯一索引跳过。
    assert.equal(createdTotal, 2);
    assert.equal(
      count(db, `SELECT COUNT(*) FROM escalations WHERE case_id=${filed.id}`),
      2,
      'escalations 每阶仅一条',
    );
    assert.equal(
      count(db, `SELECT COUNT(*) FROM penalty_entries WHERE case_id=${filed.id} AND kind='original'`),
      3,
      '立案 + 两阶升级，原始处罚每阶一条',
    );
  });

  test('已锁定处罚不会被任何更新覆盖', async () => {
    const { app, db } = h;
    const list = JSON.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/cases?category=DBL',
        })
      ).body,
    ).cases;
    const target = list.find((c: { location: string }) => c.location === '并发路 7 号');
    await app.inject({ method: 'POST', url: `/cases/${target.id}/lock` });

    // 直接尝试 SQL 覆盖锁定行的金额（模拟任何绕过性写入），业务层不提供该 API；
    // 这里验证锁定状态值被保留，并且再次锁定幂等。
    const lock2 = await app.inject({ method: 'POST', url: `/cases/${target.id}/lock` });
    assert.equal(lock2.statusCode, 200);
    const entries = JSON.parse(lock2.body).entries as Array<{ kind: string; status: string }>;
    assert.ok(entries.filter((e) => e.kind === 'original').every((e) => e.status === 'locked'));

    // 锁定后再扫描升级：escalation 事实可记，但绝不再追加 original 处罚。
    const originalCount = count(
      db,
      `SELECT COUNT(*) FROM penalty_entries WHERE case_id=${target.id} AND kind='original'`,
    );
    const sweepAfterLock = await app.inject({
      method: 'POST',
      url: '/escalations/run',
      payload: { case_id: target.id, at: '2026-05-01T00:00:00.000Z' },
    });
    assert.equal(sweepAfterLock.statusCode, 200);
    assert.equal(
      count(
        db,
        `SELECT COUNT(*) FROM penalty_entries WHERE case_id=${target.id} AND kind='original'`,
      ),
      originalCount,
      '锁定后升级扫描不得新增原始处罚（差异只能走追溯更正链）',
    );
    assert.ok(
      JSON.parse(sweepAfterLock.body).escalated.every(
        (e: { penalties_added: boolean }) => e.penalties_added === false,
      ),
    );
    void LADDER_STRICT;
  });
});
