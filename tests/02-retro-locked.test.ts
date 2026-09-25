import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Harness } from './helpers.ts';
import { makeApp, publishRule, seedCategory, LADDER_STD, LADDER_STRICT, count } from './helpers.ts';

/**
 * 验收 2：回填（追溯生效）规则命中锁定处罚时，原版必须保留，
 * 经确认后【追加】correction 更正与 review 复核，不覆盖。
 */
describe('追溯规则命中锁定处罚：保留原版 + 追加处理链', () => {
  let h: Harness;

  before(async () => {
    h = await makeApp();
  });

  test('生成影响清单 -> 确认 -> 追加链', async () => {
    const { app, clock, db } = h;
    await seedCategory(app, 'WGT', '违规占道');

    clock.setNow('2026-03-01T00:00:00.000Z');
    const r1 = await publishRule(app, { category_code: 'WGT', content: LADDER_STD });
    const stdId = r1.body.rule.id;

    clock.setNow('2026-03-10T00:00:00.000Z');
    const filed = JSON.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/cases',
          payload: {
            category_code: 'WGT',
            occurred_at: '2026-03-01T00:00:00.000Z',
            location: '锁定案路 9 号',
            case_no: 'AJ-LOCK-1',
          },
        })
      ).body,
    );

    // 锁定案件原始处罚。
    const lock = await app.inject({ method: 'POST', url: `/cases/${filed.id}/lock` });
    assert.equal(lock.statusCode, 200);
    const lockedOrig = JSON.parse(lock.body).entries;
    assert.ok(lockedOrig.every((e: { status: string }) => e.status === 'locked'));

    // 发布追溯规则（不替代、不截断任何常规规则）。
    clock.setNow('2026-04-01T00:00:00.000Z');
    const retro = await publishRule(app, {
      category_code: 'WGT',
      retroactive: true,
      effective_from: '2026-03-31T00:00:00.000Z',
      content: LADDER_STRICT,
    });
    assert.equal(retro.status, 200);
    const retroId = retro.body.rule.id;
    assert.deepEqual(retro.body.superseded_version_ids, []);
    // 常规解析仍命中旧规则：追溯规则不参与正常解析。
    const checkCase = JSON.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/cases',
          payload: {
            category_code: 'WGT',
            occurred_at: '2026-03-15T00:00:00.000Z',
            location: '旁路 3 号',
          },
        })
      ).body,
    );
    assert.equal(checkCase.rule_version_id, stdId);

    // 生成影响清单。
    const gen = await app.inject({ method: 'POST', url: `/rules/${retroId}/impact/generate` });
    assert.equal(gen.statusCode, 200);
    const generated = JSON.parse(gen.body).generated as Array<{
      id: number;
      target: string;
      case_no: string;
    }>;
    const hit = generated.find((g) => g.case_no === 'AJ-LOCK-1');
    assert.ok(hit, '锁定案件应出现在影响清单中');
    assert.equal(hit.target, 'locked_penalty');

    // 原台账在确认前必须纹丝不动。
    assert.equal(
      count(db, `SELECT COUNT(*) FROM penalty_entries WHERE case_id=${filed.id} AND kind='original' AND status='locked'`),
      1,
    );
    assert.equal(
      count(db, `SELECT COUNT(*) FROM penalty_entries WHERE case_id=${filed.id} AND kind='correction'`),
      0,
    );

    // 确认影响清单。
    const confirm = await app.inject({
      method: 'POST',
      url: `/impacts/${hit.id}/confirm`,
      payload: { action: 'confirm', reason: '考核委复核确认按更严口径更正' },
    });
    assert.equal(confirm.statusCode, 200);

    // 处罚详情规则链：original 锁定保留 + correction + review。
    const detail = JSON.parse(
      (await app.inject({ url: `/cases/${filed.id}/penalty-detail` })).body,
    );
    const orig = detail.entries.filter((e: { kind: string }) => e.kind === 'original');
    const corr = detail.entries.filter((e: { kind: string }) => e.kind === 'correction');
    const rev = detail.entries.filter((e: { kind: string }) => e.kind === 'review');
    assert.equal(orig.length, 1);
    assert.equal(orig[0].status, 'locked');
    assert.equal(orig[0].fine, 200, '原锁定处罚金额不得被覆盖');
    assert.equal(orig[0].rule_version_id, stdId, '原条目仍指向旧规则版本');
    assert.ok(corr.length >= 1, '必须追加更正条目');
    assert.ok(corr.every((e: { rule_version_id: number }) => e.rule_version_id === retroId));
    assert.equal(rev.length, 1, '必须追加一条复核');
    assert.equal(rev[0].status, 'reviewed');
    assert.ok(corr.every((e: { origin_entry_id: number | null }) => e.origin_entry_id === orig[0].id)
      || corr[0].origin_entry_id === orig[0].id, 'correction 链接到原处罚');

    // 冻结快照未被重算。
    assert.equal(detail.snapshot.rectify_hours, 24);
    assert.equal(detail.frozen_rule_version_id, stdId);

    // 再次确认必须幂等，不产生第二组更正/复核。
    const again = await app.inject({
      method: 'POST',
      url: `/impacts/${hit.id}/confirm`,
      payload: { action: 'confirm' },
    });
    assert.equal(again.statusCode, 200);
    assert.equal(JSON.parse(again.body).idempotent, true);
    assert.equal(
      count(db, `SELECT COUNT(*) FROM penalty_entries WHERE case_id=${filed.id} AND kind='review'`),
      1,
      '复核条目不得重复',
    );
    const corrCount = count(
      db,
      `SELECT COUNT(*) FROM penalty_entries WHERE case_id=${filed.id} AND kind='correction'`,
    );
    const againGen = await app.inject({ method: 'POST', url: `/rules/${retroId}/impact/generate` });
    assert.equal(JSON.parse(againGen.body).count, 0, '影响清单重复生成幂等');
    assert.equal(
      count(db, `SELECT COUNT(*) FROM penalty_entries WHERE case_id=${filed.id} AND kind='correction'`),
      corrCount,
    );
  });
});
