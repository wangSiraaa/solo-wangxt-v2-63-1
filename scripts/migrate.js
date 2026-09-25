'use strict';

/**
 * 可重复执行的模型迁移脚本：
 *   node scripts/migrate.js --db data.json
 * 加载既有台账 → 运行基准规则迁移（幂等）→ 写回。
 */
const { Store, buildIndexes } = require('../src/store');
const { runBaselineMigration } = require('../src/migration');
const { systemClock } = require('../src/clock');

function main() {
  const args = process.argv.slice(2);
  const dbIdx = args.indexOf('--db');
  const dbFile = dbIdx >= 0 ? args[dbIdx + 1] : 'data.json';

  const store = Store.load(dbFile);
  const idx = buildIndexes(store);
  const report = runBaselineMigration(store, idx, systemClock());
  store.save(dbFile);

  console.log(JSON.stringify(report, null, 2));
  if (report.migrated_count === 0 && !report.baseline_created) {
    console.error('无待迁移数据：基准规则已存在且所有立案均已冻结规则快照（幂等）。');
  } else {
    console.error(`迁移完成：基准规则 ${report.baseline_rule_id}，迁移立案 ${report.migrated_count} 件。`);
  }
}

main();
