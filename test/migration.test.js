'use strict';

/** 迁移脚本（可重复执行）与落盘回归测试 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, buildIndexes } = require('../src/store');
const { manualClock } = require('../src/clock');
const { runBaselineMigration } = require('../src/migration');

function seedLegacy(store) {
  store.insert('contracts', {
    id: 'ct-legacy',
    name: '旧保洁合同',
    contractor: '旧公司',
    valid_from: null,
    valid_to: null,
    created_at: '2025-01-01T00:00:00.000Z',
  });
  store.insert('cases', {
    id: 'case-legacy',
    case_no: 'AJ-LEGACY-9',
    event_time: '2025-06-01T00:00:00.000Z',
    category: 'STALL',
    description: '迁移前占道经营',
    reporter: null,
    contract_id: 'ct-legacy',
    status: 'FILED',
    rule_version_id: null,
    rule_snapshot: null,
    calc_basis: null,
    deadline: '2025-06-04T00:00:00.000Z',
    rectified_at: null,
    created_at: '2025-06-01T01:00:00.000Z',
  });
  store.insert('photos', {
    id: 'photo-legacy',
    case_id: 'case-legacy',
    url: 'oss://legacy.jpg',
    kind: 'EVIDENCE',
    taken_at: null,
    created_at: '2025-06-01T02:00:00.000Z',
  });
  store.seqs = { case: 1, photo: 1 };
}

test('迁移脚本可重复执行：首次迁移、二次幂等，既有归属保留', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  const dbFile = path.join(tmp, 'data.json');

  // 造一份旧台账落盘
  const store = new Store();
  seedLegacy(store);
  store.save(dbFile);

  const script = path.join(__dirname, '..', 'scripts', 'migrate.js');
  const out1 = execFileSync(process.execPath, [script, '--db', dbFile], { encoding: 'utf8' });
  const report1 = JSON.parse(out1);
  assert.equal(report1.migrated_count, 1);
  assert.equal(report1.baseline_created, true);

  // 二次执行：幂等
  const out2 = execFileSync(process.execPath, [script, '--db', dbFile], { encoding: 'utf8' });
  const report2 = JSON.parse(out2);
  assert.equal(report2.migrated_count, 0);
  assert.equal(report2.baseline_created, false);
  assert.equal(report2.baseline_rule_id, report1.baseline_rule_id);

  // 落盘数据回归：快照已冻结、照片与合同归属保留
  const loaded = Store.load(dbFile);
  const idx = buildIndexes(loaded); // 索引可从数据重建
  const c = loaded.get('cases', 'case-legacy');
  assert.equal(c.rule_snapshot.code, 'baseline-legacy');
  assert.equal(c.calc_basis.resolution, 'BASELINE_MIGRATION');
  assert.equal(loaded.get('photos', 'photo-legacy').case_id, 'case-legacy');
  assert.equal(c.contract_id, 'ct-legacy');
  assert.ok(idx.ruleCodeVersion, '索引重建成功');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('迁移事务性：中途失败则整体回滚，原台账完整保留', () => {
  const store = new Store();
  seedLegacy(store);
  // 预置同代码同版本但非 baseline 的规则：基准规则创建将触发唯一约束冲突（迁移中途失败）
  store.insert('rules', {
    id: 'rule-squatter',
    code: 'baseline-legacy',
    version: 1,
    status: 'DRAFT',
    retroactive: false,
    baseline: false,
    effective_from: '2026-01-01T00:00:00.000Z',
    effective_to: null,
    payload: null,
    note: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    validated_at: null,
    published_at: null,
    withdrawn_at: null,
    superseded_by: null,
  });
  const idx = buildIndexes(store);
  const clock = manualClock('2026-01-01T00:00:00.000Z');
  const before = structuredClone(store.tables);

  assert.throws(() => runBaselineMigration(store, idx, clock), /唯一约束冲突/);
  assert.deepEqual(store.tables, before, '迁移失败必须回滚，旧台账原样保留');
  // 旧案仍未挂接规则快照，可修复冲突后重跑迁移
  assert.equal(store.get('cases', 'case-legacy').rule_version_id, null);
});
