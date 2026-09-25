'use strict';

const { conflict } = require('./errors');

const TABLES = [
  'rules', // 规则版本
  'cases', // 立案
  'rectifications', // 整改单
  'photos', // 照片（取证/整改）
  'contracts', // 合同归属
  'escalations', // 升级记录
  'penalties', // 处罚
  'chain_entries', // 处罚规则链 / 处理链
  'impacts', // 追溯影响清单
  'corrections', // 更正
  'reviews', // 复核
];

/**
 * 内存台账：表 + 唯一索引 + 自增序号。
 * tx() 提供快照式事务：任一写失败整体回滚，保证“失败时原台账完整保留”。
 * 所有写路径为同步临界区（check-then-insert 之间无 await），
 * 叠加唯一索引兜底，重复发布/并发升级不会产生双记录。
 */
class Store {
  constructor() {
    this.tables = {};
    for (const t of TABLES) this.tables[t] = {};
    this.indexes = {}; // name -> Map(key -> id)
    this.seqs = {};
  }

  nextId(prefix) {
    this.seqs[prefix] = (this.seqs[prefix] || 0) + 1;
    return `${prefix}-${this.seqs[prefix]}`;
  }

  tx(fn) {
    const snapshot = structuredClone({
      tables: this.tables,
      indexes: Object.fromEntries(
        Object.entries(this.indexes).map(([k, v]) => [k, Array.from(v.entries())])
      ),
      seqs: this.seqs,
    });
    try {
      const result = fn();
      if (this.onCommit) this.onCommit(); // 写穿持久化钩子（可选）
      return result;
    } catch (err) {
      this.tables = snapshot.tables;
      this.indexes = Object.fromEntries(
        Object.entries(snapshot.indexes).map(([k, v]) => [k, new Map(v)])
      );
      this.seqs = snapshot.seqs;
      throw err;
    }
  }

  defineIndex(name, table, keyFn) {
    this.indexes[name] = new Map();
    for (const row of Object.values(this.tables[table])) {
      this.indexes[name].set(keyFn(row), row.id);
    }
    return { name, table, keyFn };
  }

  /** 唯一约束校验 + 写入索引；冲突抛 409，由服务层决定报错或返回既有记录（幂等）。 */
  assertUnique(index, row) {
    const key = index.keyFn(row);
    const existing = this.indexes[index.name].get(key);
    if (existing !== undefined) {
      throw conflict('DUPLICATE_RECORD', `唯一约束冲突: ${index.name}`, {
        index: index.name,
        key,
        existing_id: existing,
      });
    }
    this.indexes[index.name].set(key, row.id);
  }

  lookup(index, key) {
    const id = this.indexes[index.name].get(key);
    return id === undefined ? null : this.tables[index.table][id] || null;
  }

  insert(table, row) {
    this.tables[table][row.id] = row;
    return row;
  }

  get(table, id) {
    return this.tables[table][id] || null;
  }

  all(table) {
    return Object.values(this.tables[table]);
  }

  where(table, pred) {
    return Object.values(this.tables[table]).filter(pred);
  }

  /** 序列化（索引不落盘，加载时由数据重建） */
  toJSON() {
    return { tables: this.tables, seqs: this.seqs };
  }

  static fromJSON(json) {
    const store = new Store();
    for (const t of TABLES) store.tables[t] = (json.tables && json.tables[t]) || {};
    store.seqs = json.seqs || {};
    return store;
  }

  save(file) {
    const fs = require('fs');
    fs.writeFileSync(file, JSON.stringify(this.toJSON(), null, 2));
  }

  static load(file) {
    const fs = require('fs');
    if (!fs.existsSync(file)) return new Store();
    return Store.fromJSON(JSON.parse(fs.readFileSync(file, 'utf8')));
  }
}

/** 组合键工具 */
const keyOf = (...parts) => parts.map((p) => String(p)).join('');

function buildIndexes(store) {
  const idx = {
    ruleCodeVersion: store.defineIndex('rule_code_version', 'rules', (r) =>
      keyOf(r.code, '@v', r.version)
    ),
    escalationCaseLevel: store.defineIndex('escalation_case_level', 'escalations', (e) =>
      keyOf(e.case_id, '#L', e.level)
    ),
    penaltyEscalation: store.defineIndex('penalty_escalation', 'penalties', (p) =>
      keyOf(p.escalation_id)
    ),
    impactDedup: store.defineIndex('impact_dedup', 'impacts', (i) =>
      keyOf(i.rule_version_id, '|', i.case_id, '|', i.penalty_id || '-', '|', i.kind)
    ),
    correctionImpact: store.defineIndex('correction_impact', 'corrections', (c) =>
      keyOf(c.impact_id)
    ),
    reviewCorrection: store.defineIndex('review_correction', 'reviews', (r) =>
      keyOf(r.correction_id)
    ),
  };
  return idx;
}

module.exports = { Store, buildIndexes, keyOf };
