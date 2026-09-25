import type { Database } from 'sql.js';
import { queryAll, runStmt } from '../src/db.ts';
import { canonicalJson, contentSha256 } from '../src/domain/rule-engine.ts';

/**
 * 002 —— 旧台账数据迁移为“基准规则”：
 *
 * 1. 建立旧表（legacy_*），模拟既有系统：类别、案件、照片、整改、合同、旧处罚。
 * 2. 旧表为空时植入演示旧数据；已有数据则原样保留（迁移可重入）。
 * 3. 为每个类别生成一条【基准规则】（BASELINE_xxx, v1, effective），
 *    窗口左开（-∞ 起），内容为旧系统长期沿用的类别分值/整改时限/阶梯。
 * 4. legacy_cases 迁移到 cases：按“事件发生时间”命中基准规则并冻结快照与计算依据；
 *    照片/整改/合同/旧处罚归属一并迁移，全部挂到新 case_id 下，可直接回归查询。
 *
 * 迁移幂等：基准规则固定 code + version_no，案件按 case_no 去重，
 * 已迁移的旧行不重复处理。
 */
export const id = '002';
export const name = 'legacy_baseline_migration';

interface LegacySpec {
  category_code: string;
  category_name: string;
  base_score: number;
  base_fine: number;
  rectify_hours: number;
  ladder: { step: number; after_hours: number; score: number; fine: number; action: string }[];
}

const BASELINE_SPECS: LegacySpec[] = [
  {
    category_code: 'ZSJ',
    category_name: '占道经营',
    base_score: 2,
    base_fine: 200,
    rectify_hours: 24,
    ladder: [
      { step: 0, after_hours: 0, score: 2, fine: 200, action: '责令立即改正' },
      { step: 1, after_hours: 24, score: 5, fine: 500, action: '加处罚款并再次催告' },
      { step: 2, after_hours: 72, score: 10, fine: 1000, action: '暂扣经营工具' },
    ],
  },
  {
    category_code: 'LJL',
    category_name: '乱堆物料',
    base_score: 1,
    base_fine: 100,
    rectify_hours: 12,
    ladder: [
      { step: 0, after_hours: 0, score: 1, fine: 100, action: '责令限期清理' },
      { step: 1, after_hours: 12, score: 3, fine: 300, action: '加处罚款' },
      { step: 2, after_hours: 48, score: 8, fine: 800, action: '代为清理并追偿费用' },
    ],
  },
  {
    category_code: 'XGZ',
    category_name: '违规张贴小广告',
    base_score: 1,
    base_fine: 50,
    rectify_hours: 6,
    ladder: [
      { step: 0, after_hours: 0, score: 1, fine: 50, action: '责令清除' },
      { step: 1, after_hours: 6, score: 3, fine: 200, action: '加处罚款并停机复核号码' },
    ],
  },
];

export function up(db: Database, nowIso: string): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS legacy_categories (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS legacy_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_no TEXT NOT NULL UNIQUE,
      category_code TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      filed_at TEXT NOT NULL,
      location TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      migrated_case_id INTEGER
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS legacy_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      legacy_case_no TEXT NOT NULL,
      ref_no TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS legacy_rectifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      legacy_case_no TEXT NOT NULL,
      ref_no TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      rectified_at TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS legacy_contracts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      legacy_case_no TEXT NOT NULL,
      contract_no TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS legacy_penalties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      legacy_case_no TEXT NOT NULL,
      amount REAL NOT NULL,
      score INTEGER NOT NULL,
      action TEXT NOT NULL,
      locked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);

  seedLegacyIfEmpty(db);

  const baselineIdByCategory = new Map<string, number>();
  for (const spec of BASELINE_SPECS) {
    const content = {
      category_code: spec.category_code,
      base_score: spec.base_score,
      base_fine: spec.base_fine,
      rectify_hours: spec.rectify_hours,
      ladder: spec.ladder,
    };
    runStmt(
      db,
      `INSERT INTO categories(code, name, created_at) VALUES (?,?,?)
       ON CONFLICT(code) DO NOTHING`,
      [spec.category_code, spec.category_name, nowIso],
    );

    const existing = queryAll(
      db,
      `SELECT id FROM rule_versions WHERE rule_code=? AND version_no=1`,
      [`BASELINE_${spec.category_code}`],
    )[0];
    let idNum: number;
    if (existing) {
      idNum = existing.id as number;
    } else {
      idNum = runStmt(
        db,
        `INSERT INTO rule_versions
           (rule_code, version_no, category_code, status, effective_from, effective_to,
            is_retroactive, content_json, content_sha256, validated_at, published_at, created_at)
         VALUES (?,1,?,'effective',NULL,NULL,0,?,?,?,?,?)`,
        [
          `BASELINE_${spec.category_code}`,
          spec.category_code,
          canonicalJson(content),
          contentSha256(content),
          nowIso,
          nowIso,
          nowIso,
        ],
      );
    }
    baselineIdByCategory.set(spec.category_code, idNum);
  }

  migrateLegacyCases(db, nowIso);
}

function seedLegacyIfEmpty(db: Database): void {
  const count = db.exec('SELECT COUNT(*) FROM legacy_cases')[0]?.values[0][0];
  if (Number(count) > 0) return;

  for (const spec of BASELINE_SPECS) {
    runStmt(db, `INSERT INTO legacy_categories(code, name) VALUES (?,?) ON CONFLICT DO NOTHING`, [
      spec.category_code,
      spec.category_name,
    ]);
  }

  const demo = [
    {
      case_no: 'LG-2026-0001',
      category_code: 'ZSJ',
      occurred_at: '2026-01-10T08:00:00.000Z',
      filed_at: '2026-01-10T09:30:00.000Z',
      location: '和平路与建设大街交口',
      description: '早点摊外摆占用盲道（旧系统历史案件）',
      photos: [{ ref_no: 'P-LG-0001-1', title: '现场占道照片', url: 'oss://legacy/p-lg-0001-1.jpg' }],
      rect: [
        {
          ref_no: 'R-LG-0001-1',
          title: '整改回执',
          url: 'oss://legacy/r-lg-0001-1.pdf',
          rectified_at: '2026-01-11T02:00:00.000Z',
        },
      ],
      contract: { contract_no: 'HT-LG-0001', title: '门前三包责任书', url: 'oss://legacy/ht-lg-0001.pdf' },
      penalty: { amount: 200, score: 2, action: '责令立即改正', locked: 1 },
    },
    {
      case_no: 'LG-2026-0002',
      category_code: 'LJL',
      occurred_at: '2026-02-03T14:00:00.000Z',
      filed_at: '2026-02-03T15:00:00.000Z',
      location: '新华街 12 号门前',
      description: '装修垃圾堆置人行道（旧系统历史案件）',
      photos: [{ ref_no: 'P-LG-0002-1', title: '堆料照片', url: 'oss://legacy/p-lg-0002-1.jpg' }],
      rect: [] as { ref_no: string; title: string; url: string; rectified_at: string }[],
      contract: { contract_no: 'HT-LG-0002', title: '市容环卫责任书', url: 'oss://legacy/ht-lg-0002.pdf' },
      penalty: { amount: 100, score: 1, action: '责令限期清理', locked: 0 },
    },
  ];

  for (const c of demo) {
    runStmt(
      db,
      `INSERT INTO legacy_cases(case_no, category_code, occurred_at, filed_at, location, description)
       VALUES (?,?,?,?,?,?)`,
      [c.case_no, c.category_code, c.occurred_at, c.filed_at, c.location, c.description],
    );
    for (const p of c.photos) {
      runStmt(
        db,
        `INSERT INTO legacy_photos(legacy_case_no, ref_no, title, url) VALUES (?,?,?,?)`,
        [c.case_no, p.ref_no, p.title, p.url],
      );
    }
    for (const r of c.rect) {
      runStmt(
        db,
        `INSERT INTO legacy_rectifications(legacy_case_no, ref_no, title, url, rectified_at)
         VALUES (?,?,?,?,?)`,
        [c.case_no, r.ref_no, r.title, r.url, r.rectified_at],
      );
    }
    runStmt(
      db,
      `INSERT INTO legacy_contracts(legacy_case_no, contract_no, title, url) VALUES (?,?,?,?)`,
      [c.case_no, c.contract.contract_no, c.contract.title, c.contract.url],
    );
    runStmt(
      db,
      `INSERT INTO legacy_penalties(legacy_case_no, amount, score, action, locked, created_at)
       VALUES (?,?,?,?,?,?)`,
      [c.case_no, c.penalty.amount, c.penalty.score, c.penalty.action, c.penalty.locked, c.filed_at],
    );
  }
}

function migrateLegacyCases(db: Database, nowIso: string): void {
  const rows = queryAll(
    db,
    `SELECT lc.id AS lid, lc.case_no, lc.category_code, lc.occurred_at, lc.filed_at,
            lc.location, lc.description,
            rv.id AS rule_id, rv.content_json
     FROM legacy_cases lc
     JOIN rule_versions rv
       ON rv.rule_code = 'BASELINE_' || lc.category_code AND rv.version_no = 1
     WHERE lc.migrated_case_id IS NULL
     ORDER BY lc.id`,
  );

  for (const lc0 of rows) {
    const lc = lc0 as Record<string, number | string | null>;
    const content = JSON.parse(lc.content_json as string);
    const t0 = content.ladder[0];
    const basis = {
      source: 'legacy_baseline_migration',
      resolved_by: 'event_occurred_at',
      occurred_at: lc.occurred_at,
      window: { effective_from: null, effective_to: null },
      rule_code: `BASELINE_${lc.category_code}`,
      base_score: content.base_score,
      base_fine: content.base_fine,
      rectify_hours: content.rectify_hours,
      base_tier: t0,
    };

    const existing = queryAll(db, `SELECT id FROM cases WHERE case_no=?`, [lc.case_no])[0];
    let caseId: number;
    if (existing) {
      caseId = existing.id as number;
    } else {
      caseId = runStmt(
        db,
        `INSERT INTO cases(case_no, category_code, occurred_at, filed_at, location, description,
                           status, rule_version_id, rule_snapshot_json, calc_basis_json, created_at)
         VALUES (?,?,?,?,?,?,'open',?,?,?,?)`,
        [
          lc.case_no,
          lc.category_code,
          lc.occurred_at,
          lc.filed_at,
          lc.location,
          lc.description,
          lc.rule_id,
          lc.content_json,
          canonicalJson(basis),
          nowIso,
        ],
      );
    }

    moveAttachments(db, lc.case_no as string, caseId, nowIso);
    moveLegacyPenalties(db, lc.case_no as string, caseId, lc.rule_id as number, nowIso);

    runStmt(db, `UPDATE legacy_cases SET migrated_case_id=? WHERE id=?`, [caseId, lc.lid]);
  }
}

function moveAttachments(db: Database, caseNo: string, caseId: number, nowIso: string): void {
  const exists = queryAll(db, `SELECT 1 AS x FROM attachments WHERE case_id=? LIMIT 1`, [caseId])[0];
  if (exists) return;

  for (const kind of ['photo', 'rectification', 'contract'] as const) {
    const [table, noCol]: [string, string] =
      kind === 'photo'
        ? ['legacy_photos', 'ref_no']
        : kind === 'rectification'
          ? ['legacy_rectifications', 'ref_no']
          : ['legacy_contracts', 'contract_no'];
    const rows = queryAll(
      db,
      `SELECT ${noCol} AS ref_no, title, url FROM ${table} WHERE legacy_case_no=?`,
      [caseNo],
    );
    for (const p of rows) {
      runStmt(
        db,
        `INSERT INTO attachments(case_id, kind, ref_no, title, url, created_at)
         VALUES (?,?,?,?,?,?)`,
        [caseId, kind, p.ref_no, p.title, p.url, nowIso],
      );
    }
  }
}

function moveLegacyPenalties(
  db: Database,
  caseNo: string,
  caseId: number,
  ruleId: number,
  nowIso: string,
): void {
  const already = queryAll(
    db,
    `SELECT 1 AS x FROM penalty_entries WHERE case_id=? AND kind='original' LIMIT 1`,
    [caseId],
  )[0];
  if (already) return;

  const rows = queryAll(
    db,
    `SELECT amount, score, action, locked FROM legacy_penalties WHERE legacy_case_no=?
     ORDER BY id LIMIT 1`,
    [caseNo],
  );
  for (const p0 of rows) {
    const p = p0 as Record<string, number>;
    runStmt(
      db,
      `INSERT INTO penalty_entries
         (case_id, entry_code, kind, status, rule_version_id, step, score, fine, action,
          origin_entry_id, impact_item_id, reason, created_at)
       VALUES (?,?, 'original', ?, ?, 0, ?, ?, ?, NULL, NULL, 'legacy_penalty_migrated', ?)`,
      [
        caseId,
        `P-${caseNo}-ORIG`,
        p.locked ? 'locked' : 'active',
        ruleId,
        p.score,
        p.amount,
        p.action,
        nowIso,
      ],
    );
  }
}
