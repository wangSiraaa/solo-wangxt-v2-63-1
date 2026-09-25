import type { Database } from 'sql.js';

/**
 * 001 —— 新台账全量模型：
 * 规则版本闭环、立案快照冻结、时钟升级、处罚追加链、追溯影响清单、附件归属。
 */
export const id = '001';
export const name = 'core_schema';

export function up(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS categories (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS rule_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_code TEXT NOT NULL,
      version_no INTEGER NOT NULL,
      category_code TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft','validated','effective','superseded','withdrawn')),
      effective_from TEXT,
      effective_to TEXT,
      is_retroactive INTEGER NOT NULL DEFAULT 0,
      content_json TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      validated_at TEXT,
      published_at TEXT,
      superseded_by INTEGER,
      created_at TEXT NOT NULL,
      UNIQUE(rule_code, version_no),
      UNIQUE(content_sha256, category_code)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_no TEXT NOT NULL UNIQUE,
      category_code TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      filed_at TEXT NOT NULL,
      location TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','rectified','closed')),
      rule_version_id INTEGER NOT NULL REFERENCES rule_versions(id),
      rule_snapshot_json TEXT NOT NULL,
      calc_basis_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_cases_occurred ON cases(occurred_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_cases_category ON cases(category_code)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS escalations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER NOT NULL REFERENCES cases(id),
      rule_version_id INTEGER NOT NULL REFERENCES rule_versions(id),
      step INTEGER NOT NULL,
      score INTEGER NOT NULL,
      fine REAL NOT NULL,
      action TEXT NOT NULL,
      due_at TEXT NOT NULL,
      escalated_at TEXT NOT NULL,
      UNIQUE(case_id, step)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS penalty_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER NOT NULL REFERENCES cases(id),
      entry_code TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('original','correction','review')),
      status TEXT NOT NULL CHECK (status IN ('active','locked','corrected','reviewed')),
      rule_version_id INTEGER NOT NULL REFERENCES rule_versions(id),
      step INTEGER NOT NULL,
      score INTEGER NOT NULL,
      fine REAL NOT NULL,
      action TEXT NOT NULL,
      origin_entry_id INTEGER REFERENCES penalty_entries(id),
      impact_item_id INTEGER,
      reason TEXT,
      created_at TEXT NOT NULL
    )
  `);
  // 原始处罚每案每阶至多一条；更正/复核条目按影响项幂等。
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_penalty_original_once
      ON penalty_entries(case_id, step) WHERE kind = 'original'
  `);
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_penalty_impact_once
      ON penalty_entries(impact_item_id, kind, step) WHERE impact_item_id IS NOT NULL
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS impact_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      retroactive_version_id INTEGER NOT NULL REFERENCES rule_versions(id),
      case_id INTEGER NOT NULL REFERENCES cases(id),
      case_no TEXT NOT NULL,
      target TEXT NOT NULL CHECK (target IN ('frozen_case','locked_penalty')),
      detail_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','ignored')),
      processed_penalty_entry_id INTEGER REFERENCES penalty_entries(id),
      confirmed_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(retroactive_version_id, case_id, target)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER NOT NULL REFERENCES cases(id),
      kind TEXT NOT NULL CHECK (kind IN ('photo','rectification','contract')),
      ref_no TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_attach_case ON attachments(case_id)`);
}
