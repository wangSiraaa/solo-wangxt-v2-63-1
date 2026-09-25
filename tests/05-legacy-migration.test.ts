import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Harness } from './helpers.ts';
import { makeApp } from './helpers.ts';
import { Db } from '../src/db.ts';
import { Clock } from '../src/domain/clock.ts';
import { runMigrations } from '../src/migrator.ts';

/**
 * 验收 5：旧数据迁移为基准规则后，既有照片、整改、合同归属可直接回归；
 * 且迁移幂等（重复执行不产生重复基准规则/案件/附件/处罚）。
 */
describe('旧数据迁移为基准规则 + 归属回归', () => {
  let h: Harness;
  before(async () => {
    h = await makeApp();
  });

  test('基准规则与冻结快照', async () => {
    const { app } = h;
    const rules = JSON.parse((await app.inject({ url: '/rules?status=effective' })).body).versions;
    const baselines = rules.filter((r: { rule_code: string }) =>
      r.rule_code.startsWith('BASELINE_'),
    );
    assert.equal(baselines.length, 3, 'ZSJ/LJL/XGZ 三条基准规则');
    assert.ok(baselines.every((r: { effective_from: null; effective_to: null }) => r.effective_from === null && r.effective_to === null));
  });

  test('旧案件按事件时间命中基准规则并冻结', async () => {
    const { app } = h;
    const { cases } = JSON.parse((await app.inject({ url: '/cases' })).body);
    assert.equal(cases.length, 2);
    for (const c of cases) {
      assert.match(c.rule_snapshot.ladder[0].action, /./);
      assert.equal(c.calc_basis.source, 'legacy_baseline_migration');
      assert.equal(c.calc_basis.resolved_by, 'event_occurred_at');
    }
    const zsj = cases.find((c: { case_no: string }) => c.case_no === 'LG-2026-0001');
    assert.equal(zsj.rule_snapshot.rectify_hours, 24);
    assert.equal(zsj.rule_snapshot.base_fine, 200);
  });

  test('照片/整改/合同归属直接回归到案件', async () => {
    const { app } = h;
    const detail = JSON.parse(
      (await app.inject({ url: '/cases?case_no=' })).body,
    );
    void detail;
    const { cases } = JSON.parse((await app.inject({ url: '/cases' })).body);
    const c1 = cases.find((c: { case_no: string }) => c.case_no === 'LG-2026-0001');

    const d1 = JSON.parse((await app.inject({ url: `/cases/${c1.id}` })).body);
    const byKind = (k: string) => d1.attachments.filter((a: { kind: string }) => a.kind === k);
    assert.equal(byKind('photo').length, 1);
    assert.equal(byKind('photo')[0].ref_no, 'P-LG-0001-1');
    assert.equal(byKind('rectification').length, 1);
    assert.equal(byKind('contract').length, 1);
    assert.equal(byKind('contract')[0].ref_no, 'HT-LG-0001');

    // 案件 2 无整改回执，但照片与合同完整。
    const c2 = cases.find((c: { case_no: string }) => c.case_no === 'LG-2026-0002');
    const d2 = JSON.parse((await app.inject({ url: `/cases/${c2.id}` })).body);
    assert.equal(d2.attachments.filter((a: { kind: string }) => a.kind === 'photo').length, 1);
    assert.equal(d2.attachments.filter((a: { kind: string }) => a.kind === 'rectification').length, 0);
    assert.equal(d2.attachments.filter((a: { kind: string }) => a.kind === 'contract').length, 1);
  });

  test('旧处罚迁移为 original：锁定态保留', async () => {
    const { app } = h;
    const { cases } = JSON.parse((await app.inject({ url: '/cases' })).body);
    const c1 = cases.find((c: { case_no: string }) => c.case_no === 'LG-2026-0001');
    const c2 = cases.find((c: { case_no: string }) => c.case_no === 'LG-2026-0002');

    const pd1 = JSON.parse((await app.inject({ url: `/cases/${c1.id}/penalty-detail` })).body);
    assert.equal(pd1.entries.length, 1);
    assert.equal(pd1.entries[0].kind, 'original');
    assert.equal(pd1.entries[0].status, 'locked', '旧系统已锁定处罚迁移后仍为 locked');
    assert.equal(pd1.entries[0].fine, 200);

    const pd2 = JSON.parse((await app.inject({ url: `/cases/${c2.id}/penalty-detail` })).body);
    assert.equal(pd2.entries[0].status, 'active');
  });

  test('迁移可重复执行：幂等无双记录', async () => {
    const { db, clock } = h;
    const before = {
      rules: num(db, `SELECT COUNT(*) FROM rule_versions`),
      cases: num(db, `SELECT COUNT(*) FROM cases`),
      attachments: num(db, `SELECT COUNT(*) FROM attachments`),
      penalties: num(db, `SELECT COUNT(*) FROM penalty_entries`),
    };
    await runMigrations(db, clock); // 001/002 已记录为 applied，应全部跳过
    // 直接再执行一次 002 的 up，模拟重新跑数据迁移。
    const mod = await import('../migrations/002_legacy_baseline.ts');
    mod.up((db as unknown as { database: import('sql.js').Database }).database, new Clock().nowIso());
    const after = {
      rules: num(db, `SELECT COUNT(*) FROM rule_versions`),
      cases: num(db, `SELECT COUNT(*) FROM cases`),
      attachments: num(db, `SELECT COUNT(*) FROM attachments`),
      penalties: num(db, `SELECT COUNT(*) FROM penalty_entries`),
    };
    assert.deepEqual(after, before);
  });
});

function num(db: Db, sql: string): number {
  return Number(db.read((tx) => tx.exec(sql))[0]?.values[0][0] ?? 0);
}
