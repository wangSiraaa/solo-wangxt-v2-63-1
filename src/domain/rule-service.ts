import type { Database } from 'sql.js';
import type { Db } from '../db.js';
import { isUniqueViolation, queryAll, queryOne, runStmt, type Row } from '../db.js';
import type { Clock } from './clock.js';
import { Errors } from './errors.js';
import {
  canonicalJson,
  contentSha256,
  hoursBetween,
  parseContent,
  tierAtOverdue,
  tiersUpTo,
  validateContent,
} from './rule-engine.js';
import type { RuleContent, RuleStatus, RuleVersion } from './types.js';

export interface CreateDraftInput {
  category_code: string;
  effective_from: string | null;
  /** 追溯规则标记：只生成影响清单，不参与正常事件解析。 */
  retroactive?: boolean;
  content: unknown;
  /** 草稿阶段允许跳过结构校验（内容可为半成品）；置 true 则创建即校验。 */
  validate_now?: boolean;
}

interface StoredRule {
  id: number;
  rule_code: string;
  version_no: number;
  category_code: string;
  status: RuleStatus;
  effective_from: string | null;
  effective_to: string | null;
  is_retroactive: number;
  content_json: string;
  content_sha256: string;
  validated_at: string | null;
  published_at: string | null;
  superseded_by: number | null;
  created_at: string;
}

function toRule(r: Row): StoredRule {
  return {
    id: Number(r.id),
    rule_code: String(r.rule_code),
    version_no: Number(r.version_no),
    category_code: String(r.category_code),
    status: String(r.status) as RuleStatus,
    effective_from: (r.effective_from as string | null) ?? null,
    effective_to: (r.effective_to as string | null) ?? null,
    is_retroactive: Number(r.is_retroactive),
    content_json: String(r.content_json),
    content_sha256: String(r.content_sha256),
    validated_at: (r.validated_at as string | null) ?? null,
    published_at: (r.published_at as string | null) ?? null,
    superseded_by: r.superseded_by == null ? null : Number(r.superseded_by),
    created_at: String(r.created_at),
  };
}

/** 序列化规则版本（含解析后的内容）。 */
export function serializeRule(r: StoredRule | RuleVersion): Record<string, unknown> {
  return {
    id: r.id,
    rule_code: r.rule_code,
    version_no: r.version_no,
    category_code: r.category_code,
    status: r.status,
    effective_from: r.effective_from,
    effective_to: r.effective_to,
    is_retroactive: Boolean(r.is_retroactive),
    content: JSON.parse(r.content_json),
    content_sha256: r.content_sha256,
    validated_at: r.validated_at,
    published_at: r.published_at,
    superseded_by: r.superseded_by,
    created_at: r.created_at,
  };
}

export class RuleService {
  constructor(
    private db: Db,
    private clock: Clock,
  ) {}

  private mustGet(tx: Database, id: number): StoredRule {
    const row = queryOne(tx, `SELECT * FROM rule_versions WHERE id=?`, [id]);
    if (!row) throw Errors.notFound(`规则版本 #${id}`);
    return toRule(row);
  }

  list(filter: { category?: string; status?: RuleStatus } = {}): StoredRule[] {
    return this.db.read((tx) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (filter.category) {
        where.push('category_code=?');
        params.push(filter.category);
      }
      if (filter.status) {
        where.push('status=?');
        params.push(filter.status);
      }
      const sql = `SELECT * FROM rule_versions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                   ORDER BY category_code, is_retroactive, version_no`;
      return queryAll(tx, sql, params).map(toRule);
    });
  }

  get(id: number): StoredRule {
    return this.db.read((tx) => this.mustGet(tx, id));
  }

  /** 建立草稿。同类别同内容视为重复（唯一校验和），返回 409，不产生双记录。 */
  async createDraft(input: CreateDraftInput): Promise<StoredRule> {
    if (!input.category_code || typeof input.category_code !== 'string') {
      throw Errors.validation('category_code 必填');
    }
    const retroactive = Boolean(input.retroactive);
    let content: RuleContent | null = null;
    let rawJson: string;
    let sha: string;
    if (input.validate_now) {
      content = validateContent(input.content);
      if (content.category_code !== input.category_code) {
        throw Errors.validation('内容中的 category_code 与路径类别不一致');
      }
      rawJson = canonicalJson(content);
      sha = contentSha256(content);
    } else {
      // 草稿允许半成品，但必须是可解析 JSON；发布前必须再走 validate。
      try {
        rawJson = canonicalJson(input.content ?? {});
        JSON.parse(rawJson);
      } catch {
        throw Errors.validation('草稿内容必须是可 JSON 序列化的对象');
      }
      const maybe = validateContentSafe(input.content);
      content = maybe.ok ? maybe.value : null;
      sha = content ? contentSha256(content) : hashText(rawJson);
    }

    if (input.effective_from !== null && input.effective_from !== undefined) {
      if (Number.isNaN(new Date(input.effective_from).getTime())) {
        throw Errors.validation('effective_from 非法时间');
      }
    }

    return this.db.serialTxn((tx) => {
      const cat = queryOne(tx, `SELECT code FROM categories WHERE code=?`, [input.category_code]);
      if (!cat) throw Errors.validation(`类别 ${input.category_code} 不存在，请先建立类别`);

      const dup = queryOne(
        tx,
        `SELECT id, status FROM rule_versions WHERE category_code=? AND content_sha256=?`,
        [input.category_code, sha],
      );
      if (dup) {
        throw Errors.conflict(
          'RULE_DUPLICATE_CONTENT',
          `相同内容的规则版本已存在（#${dup.id}, ${dup.status}），禁止重复建档`,
        );
      }

      if (retroactive) {
        const n = queryOne(
          tx,
          `SELECT COUNT(*) AS c FROM rule_versions
           WHERE category_code=? AND is_retroactive=1`,
          [input.category_code],
        )!.c as number;
        const code = `RETRO_${input.category_code}_${sha.slice(0, 8)}`;
        const id = this.insertVersion(tx, {
          rule_code: code,
          version_no: n + 1,
          category_code: input.category_code,
          status: input.validate_now ? 'validated' : 'draft',
          effective_from: input.effective_from ?? null,
          effective_to: null,
          retroactive: true,
          rawJson,
          sha,
        });
        return this.mustGet(tx, id);
      }

      const row = queryOne(
        tx,
        `SELECT COALESCE(MAX(version_no),0) AS v FROM rule_versions
         WHERE category_code=? AND is_retroactive=0`,
        [input.category_code],
      )!;
      const id = this.insertVersion(tx, {
        rule_code: `STD_${input.category_code}`,
        version_no: Number(row.v) + 1,
        category_code: input.category_code,
        status: input.validate_now ? 'validated' : 'draft',
        effective_from: input.effective_from ?? null,
        effective_to: null,
        retroactive: false,
        rawJson,
        sha,
      });
      return this.mustGet(tx, id);
    });
  }

  private insertVersion(
    tx: Database,
    v: {
      rule_code: string;
      version_no: number;
      category_code: string;
      status: RuleStatus;
      effective_from: string | null;
      effective_to: string | null;
      retroactive: boolean;
      rawJson: string;
      sha: string;
    },
  ): number {
    const now = this.clock.nowIso();
    try {
      return runStmt(
        tx,
        `INSERT INTO rule_versions
           (rule_code, version_no, category_code, status, effective_from, effective_to,
            is_retroactive, content_json, content_sha256, validated_at, published_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          v.rule_code,
          v.version_no,
          v.category_code,
          v.status,
          v.effective_from,
          v.effective_to,
          v.retroactive ? 1 : 0,
          v.rawJson,
          v.sha,
          v.status === 'validated' ? now : null,
          null,
          now,
        ],
      );
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw Errors.conflict('RULE_DUPLICATE_CONTENT', '相同内容/版本号的规则已存在，禁止重复记录');
      }
      throw e;
    }
  }

  /** 校验草稿：结构合法后 draft -> validated，返回校验报告（含窗口重叠预检）。 */
  async validate(id: number): Promise<{ rule: StoredRule; overlap_check: unknown }> {
    return this.db.serialTxn((tx) => {
      const rule = this.mustGet(tx, id);
      if (rule.status === 'withdrawn' || rule.status === 'superseded') {
        throw Errors.invalidState(`规则处于 ${rule.status}，不可校验`);
      }
      const content = validateContent(JSON.parse(rule.content_json));
      const sha = contentSha256(content);
      const now = this.clock.nowIso();
      runStmt(
        tx,
        `UPDATE rule_versions SET content_json=?, content_sha256=?, status='validated', validated_at=?
         WHERE id=? AND status IN ('draft','validated')`,
        [canonicalJson(content), sha, now, id],
      );
      const overlap = rule.is_retroactive
        ? { skipped: true, reason: 'retroactive 规则不占用生效窗口，无需重叠检查' }
        : this.previewOverlap(tx, content.category_code, rule.effective_from, id);
      return { rule: this.mustGet(tx, id), overlap_check: overlap };
    });
  }

  /**
   * 发布校验通过的规则。
   * 常规规则：窗口 [effective_from, ∞)；同类别有效/未来窗口与之重叠的既有规则被截断替代
   * （允许首尾相接）；时间窗重叠（起点落在既有规则窗口之外且产生交叉）返回 422，台账不变。
   * 追溯规则：直接生效，但不截断/替代任何规则，只用于影响清单。
   * 重复发布同一版本：幂等返回已生效记录，不产生第二份记录。
   */
  async publish(
    id: number,
    opts: { effective_from?: string | null } = {},
  ): Promise<{ rule: StoredRule; superseded: number[]; idempotent: boolean }> {
    return this.db.serialTxn((tx) => {
      const rule = this.mustGet(tx, id);
      if (rule.status === 'effective') {
        // 幂等：参数一致才算重复发布；参数不一致报冲突。
        const from = opts.effective_from ?? rule.effective_from;
        if ((from ?? null) === (rule.effective_from ?? null)) {
          return { rule, superseded: [], idempotent: true };
        }
        throw Errors.conflict('RULE_ALREADY_EFFECTIVE', '规则已生效，effective_from 不可变更');
      }
      if (rule.status !== 'validated') {
        throw Errors.invalidState(`仅校验通过的规则可发布，当前状态 ${rule.status}`);
      }
      const content = validateContent(JSON.parse(rule.content_json));
      const startRaw =
        opts.effective_from !== undefined ? opts.effective_from : rule.effective_from;
      const start = startRaw ?? this.clock.nowIso();
      const startDate = new Date(start);
      if (Number.isNaN(startDate.getTime())) throw Errors.validation('effective_from 非法时间');
      if (!rule.is_retroactive && startDate.getTime() < Date.parse('2000-01-01')) {
        throw Errors.validation('常规规则不得回填到 2000 年以前；追溯请使用 retroactive 规则');
      }

      const now = this.clock.nowIso();

      if (rule.is_retroactive) {
        runStmt(
          tx,
          `UPDATE rule_versions SET status='effective', effective_from=?, published_at=? WHERE id=?`,
          [startRaw ?? start, now, id],
        );
        return { rule: this.mustGet(tx, id), superseded: [], idempotent: false };
      }

      // 常规发布：查找窗口覆盖 start 的前驱。
      // 左开规则 effective_from IS NULL 视为 -∞；右开 effective_to IS NULL 视为 +∞。
      const overlappers = queryAll(
        tx,
        `SELECT * FROM rule_versions
         WHERE category_code=? AND is_retroactive=0
           AND status IN ('effective','superseded')
           AND (effective_from IS NULL OR effective_from <= ?)
           AND (effective_to IS NULL OR effective_to > ?)
         ORDER BY (effective_from IS NULL), effective_from`,
        [content.category_code, start, start],
      ).map(toRule);

      if (overlappers.length > 1) {
        throw Errors.validation('时间窗重叠：起点与多条既有规则窗口交叉，无法确定唯一前驱', {
          overlappers: overlappers.map((o) => ({
            id: o.id,
            from: o.effective_from,
            to: o.effective_to,
          })),
        });
      }

      // 已排期的未来规则（起点晚于本次起点、且窗口与本次 [start,∞) 相交）：
      // 发布更早的规则会与之静默交叉，一律拒绝，要求先撤回/改期未来规则。
      const successors = queryAll(
        tx,
        `SELECT id, rule_code, version_no, effective_from, effective_to, status
         FROM rule_versions
         WHERE category_code=? AND is_retroactive=0 AND id<>?
           AND status='effective'
           AND effective_from IS NOT NULL AND effective_from > ?
           AND (effective_to IS NULL OR effective_to > ?)
         ORDER BY effective_from`,
        [content.category_code, id, start, start],
      );
      if (successors.length > 0) {
        throw Errors.validation('时间窗重叠：新窗口与已排期的未来规则交叉，请先撤回或改期未来规则', {
          future_rules: successors,
        });
      }

      const superseded: number[] = [];
      if (overlappers.length === 1) {
        const prev = overlappers[0];
        // 新起点必须 >= 前驱起点（含左开），否则形成非法交叉/回占。
        if (prev.effective_from && new Date(start) < new Date(prev.effective_from)) {
          throw Errors.validation('时间窗重叠：新规则起点早于其唯一前驱起点，构成交叉窗口');
        }
        runStmt(
          tx,
          `UPDATE rule_versions SET effective_to=?, status='superseded', superseded_by=? WHERE id=?`,
          [start, id, prev.id],
        );
        superseded.push(prev.id);
      }

      // 任何起点之后仍开窗口的规则（理论上被上面的重叠查询覆盖）双保险。
      runStmt(
        tx,
        `UPDATE rule_versions SET status='effective', effective_from=?, effective_to=NULL,
                 published_at=? WHERE id=?`,
        [start, now, id],
      );
      return { rule: this.mustGet(tx, id), superseded, idempotent: false };
    });
  }

  /**
   * 撤回：仅允许撤回【尚无案件命中】的规则版本。
   * 撤回未来规则时，被其截断替代的前驱恢复 effective 并重新右开窗口。
   */
  async withdraw(id: number, reason: string): Promise<{ rule: StoredRule; restored: number[] }> {
    return this.db.serialTxn((tx) => {
      const rule = this.mustGet(tx, id);
      if (rule.status !== 'effective' && rule.status !== 'validated') {
        throw Errors.invalidState(`仅生效/校验通过状态可撤回，当前 ${rule.status}`);
      }
      const used = queryOne(tx, `SELECT COUNT(*) AS c FROM cases WHERE rule_version_id=?`, [id])!.c;
      if (Number(used) > 0) {
        throw Errors.conflict(
          'RULE_IN_USE',
          `已有 ${Number(used)} 件立案按该规则冻结快照，不可撤回；新版本请另行发布`,
        );
      }
      runStmt(tx, `UPDATE rule_versions SET status='withdrawn' WHERE id=?`, [id]);
      const restored: number[] = [];
      if (!rule.is_retroactive) {
        const children = queryAll(
          tx,
          `SELECT * FROM rule_versions WHERE superseded_by=? ORDER BY version_no`,
          [id],
        ).map(toRule);
        for (const ch of children) {
          runStmt(
            tx,
            `UPDATE rule_versions SET status='effective', effective_to=NULL, superseded_by=NULL
             WHERE id=?`,
            [ch.id],
          );
          restored.push(ch.id);
        }
      }
      void reason;
      return { rule: this.mustGet(tx, id), restored };
    });
  }

  /**
   * 按【事件发生时间】解析生效中的常规规则（追溯规则永不参与正常解析）。
   * 窗口：effective_from <= at < effective_to（NULL 视为无穷）。
   */
  resolveAt(category: string, at: Date, tx?: Database): StoredRule {
    const run = (conn: Database): StoredRule => {
      const iso = at.toISOString();
      const rows = queryAll(
        conn,
        `SELECT * FROM rule_versions
         WHERE category_code=? AND is_retroactive=0 AND status IN ('effective','superseded')
           AND (effective_from IS NULL OR effective_from <= ?)
           AND (effective_to IS NULL OR effective_to > ?)
         ORDER BY effective_from DESC, version_no DESC`,
        [category, iso, iso],
      ).map(toRule);
      if (rows.length === 0) {
        throw Errors.conflict('RULE_NO_MATCH', `类别 ${category} 在 ${iso} 无生效规则`);
      }
      if (rows.length > 1) {
        throw Errors.conflict(
          'RULE_AMBIGUOUS',
          `类别 ${category} 在 ${iso} 命中 ${rows.length} 条重叠规则窗口`,
        );
      }
      return rows[0];
    };
    return tx ? run(tx) : this.db.read(run);
  }

  private previewOverlap(
    tx: Database,
    category: string,
    start: string | null,
    selfId: number,
  ): unknown {
    const at = start ? new Date(start) : this.clock.now();
    const iso = at.toISOString();
    const rows = queryAll(
      tx,
      `SELECT id, rule_code, version_no, effective_from, effective_to, status
       FROM rule_versions
       WHERE category_code=? AND is_retroactive=0 AND id<>?
         AND status IN ('effective','superseded')
         AND (effective_from IS NULL OR effective_from <= ?)
         AND (effective_to IS NULL OR effective_to > ?)`,
      [category, selfId, iso, iso],
    );
    return { at: iso, overlapping_windows: rows, ok: rows.length <= 1 };
  }

  /**
   * 试算（不落库）：在给定时间点对一组事件，按【指定草稿/版本的内容假设生效】投影阶梯。
   * 只读，不写任何台账；结构/阶梯/时间非法直接 422，原数据保持原样。
   */
  trial(id: number, atIso: string, eventTimes: string[]): {
    rule_id: number;
    at: string;
    results: { occurred_at: string; overdue_hours: number; projected_tiers: unknown[] }[];
  } {
    const rule = this.get(id);
    let content: RuleContent;
    try {
      content = validateContent(JSON.parse(rule.content_json));
    } catch (e) {
      throw Errors.trialFailed(`试算失败：规则内容未通过校验（${(e as Error).message}）`);
    }
    const at = new Date(atIso);
    if (Number.isNaN(at.getTime())) throw Errors.trialFailed('试算时间非法');
    if (!Array.isArray(eventTimes) || eventTimes.length === 0) {
      throw Errors.trialFailed('试算要求至少提供一个事件时间');
    }
    const results = eventTimes.map((occurredIso) => {
      const occurred = new Date(occurredIso);
      if (Number.isNaN(occurred.getTime())) {
        throw Errors.trialFailed(`事件时间非法：${occurredIso}`);
      }
      const overdue = Math.max(0, hoursBetween(occurredIso, at) - content.rectify_hours);
      const top = tierAtOverdue(content, overdue);
      return {
        occurred_at: occurred.toISOString(),
        rectify_hours: content.rectify_hours,
        overdue_hours: Math.round(overdue * 100) / 100,
        projected_step: top.step,
        projected_tiers: tiersUpTo(content, overdue).map((t) => ({ ...t })),
      };
    });
    return { rule_id: id, at: at.toISOString(), results };
  }
}

function validateContentSafe(input: unknown):
  | { ok: true; value: RuleContent }
  | { ok: false } {
  try {
    return { ok: true, value: validateContent(input) };
  } catch {
    return { ok: false };
  }
}

function hashText(text: string): string {
  // 草稿半成品仍需稳定指纹用于去重列。
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `draft-${(h >>> 0).toString(16).padStart(8, '0')}`;
}
