import type { Database } from 'sql.js';
import type { Db, Row } from '../db.js';
import { isUniqueViolation, queryAll, queryOne, runStmt } from '../db.js';
import type { Clock } from './clock.js';
import { Errors } from './errors.js';
import {
  canonicalJson,
  hoursBetween,
  parseContent,
  tiersUpTo,
  validateContent,
} from './rule-engine.js';
import type { RuleService } from './rule-service.js';
import type { LadderTier, RuleContent } from './types.js';

export interface FileCaseInput {
  category_code: string;
  occurred_at: string;
  location: string;
  description?: string;
  /** 可选：立案号不传则按事件年份生成，唯一索引兜底并发。 */
  case_no?: string;
}

export class CaseService {
  constructor(
    private db: Db,
    private clock: Clock,
    private rules: RuleService,
  ) {}

  /**
   * 立案：按【事件发生时间】解析规则，冻结命中版本的内容快照与计算依据。
   * 之后升级、处罚只引用 rule_version_id + 快照，永远不会被新规则静默重算。
   */
  async file(input: FileCaseInput) {
    const occurred = new Date(input.occurred_at);
    if (Number.isNaN(occurred.getTime())) throw Errors.validation('occurred_at 非法时间');
    if (!input.location) throw Errors.validation('location 必填');

    return this.db.serialTxn((tx) => {
      // 解析发生在事务内，保证“解析+冻结”对并发发布是一致的。
      const rule = this.rules.resolveAt(input.category_code, occurred, tx);
      const content = parseContent(rule);
      const filedAt = this.clock.now();
      const basis = {
        resolved_by: 'event_occurred_at',
        occurred_at: occurred.toISOString(),
        filed_at: filedAt.toISOString(),
        rule_version_id: rule.id,
        rule_code: rule.rule_code,
        version_no: rule.version_no,
        window: { effective_from: rule.effective_from, effective_to: rule.effective_to },
        base_score: content.base_score,
        base_fine: content.base_fine,
        rectify_hours: content.rectify_hours,
        base_tier: content.ladder[0],
        note: '快照在立案瞬间冻结；后续升级按本快照计算，新规则不重算既有案件',
      };

      const caseNo = input.case_no ?? this.generateCaseNo(tx, occurred);
      const t0 = content.ladder[0];
      let caseId: number;
      try {
        caseId = runStmt(
          tx,
          `INSERT INTO cases(case_no, category_code, occurred_at, filed_at, location, description,
                             status, rule_version_id, rule_snapshot_json, calc_basis_json, created_at)
           VALUES (?,?,?,?,?,?,'open',?,?,?,?)`,
          [
            caseNo,
            input.category_code,
            occurred.toISOString(),
            filedAt.toISOString(),
            input.location,
            input.description ?? '',
            rule.id,
            canonicalJson(content),
            canonicalJson(basis),
            filedAt.toISOString(),
          ],
        );
      } catch (e) {
        if (isUniqueViolation(e)) {
          throw Errors.conflict('CASE_DUPLICATE', `立案号 ${caseNo} 已存在，禁止重复立案`);
        }
        throw e;
      }

      // 立案即生成基准阶（step=0）原始处罚条目。
      this.insertOriginalPenalty(tx, caseId, rule.id, t0, filedAt.toISOString());
      return this.detail(tx, caseId);
    });
  }

  private generateCaseNo(tx: Database, occurred: Date): string {
    const year = occurred.getUTCFullYear();
    const row = queryOne(
      tx,
      `SELECT COUNT(*) AS c FROM cases WHERE strftime('%Y', occurred_at)=?`,
      [String(year)],
    )!;
    const seq = String(Number(row.c) + 1).padStart(4, '0');
    return `AJ-${year}-${seq}`;
  }

  /**
   * 时钟升级：依据【当前注入时间】对全部未结案件（或指定案件）扫描逾期阶梯。
   * 依据始终是立案快照中的 rectify_hours/ladder；(case_id, step) 唯一索引保证
   * 重复或并发扫描不会产生双记录。返回本次实际新增的升级。
   */
  async runEscalationSweep(opts: { case_id?: number; at?: string } = {}) {
    const at = opts.at ? new Date(opts.at) : this.clock.now();
    if (Number.isNaN(at.getTime())) throw Errors.validation('升级时间非法');

    return this.db.serialTxn((tx) => {
      const cases = opts.case_id
        ? queryAll(tx, `SELECT * FROM cases WHERE id=?`, [opts.case_id])
        : queryAll(tx, `SELECT * FROM cases WHERE status IN ('open','rectified') ORDER BY id`);

      const created: unknown[] = [];
      for (const c of cases) {
        const caseId = Number(c.id);
        const content = JSON.parse(String(c.rule_snapshot_json)) as RuleContent;
        const overdueHours = hoursBetween(String(c.occurred_at), at) - content.rectify_hours;
        if (overdueHours <= 0) continue;

        // 已锁定原始处罚的案件处罚固化：升级只记录 escalation 事实，
        // 不再新增 original 处罚条目；口径差异只能走追溯影响清单的
        // correction/review 追加链，绝不静默覆盖/追加原始处罚。
        const hasLockedOriginal = queryOne(
          tx,
          `SELECT 1 AS x FROM penalty_entries
           WHERE case_id=? AND kind='original' AND status='locked' LIMIT 1`,
          [caseId],
        );

        const dueTiers = tiersUpTo(content, overdueHours).filter((t) => t.step > 0);
        for (const tier of dueTiers) {
          const dueAt = new Date(
            new Date(String(c.occurred_at)).getTime() +
              (content.rectify_hours + tier.after_hours) * 3_600_000,
          );
          try {
            runStmt(
              tx,
              `INSERT INTO escalations(case_id, rule_version_id, step, score, fine, action,
                                       due_at, escalated_at)
               VALUES (?,?,?,?,?,?,?,?)`,
              [
                caseId,
                Number(c.rule_version_id),
                tier.step,
                tier.score,
                tier.fine,
                tier.action,
                dueAt.toISOString(),
                at.toISOString(),
              ],
            );
            // 升级同时生成该阶原始处罚条目（同样受唯一索引保护）；
            // 已锁定原始处罚的案件除外（处罚固化，只能经追溯链追加更正）。
            if (!hasLockedOriginal) {
              this.insertOriginalPenalty(
                tx,
                caseId,
                Number(c.rule_version_id),
                tier,
                at.toISOString(),
              );
            }
            created.push({ case_id: caseId, step: tier.step, due_at: dueAt.toISOString(), tier, penalties_added: !hasLockedOriginal });
          } catch (e) {
            if (isUniqueViolation(e)) continue; // 并发/重复扫描：已存在即跳过，无双记录
            throw e;
          }
        }
      }
      return { at: at.toISOString(), escalated: created, created_count: created.length };
    });
  }

  /**
   * 处罚锁定：把案件全部 original 条目标记为 locked。已锁定条目保持不变（幂等）。
   * 锁定后的 original 行不再接受任何 UPDATE/覆盖。
   */
  async lockPenalties(caseId: number) {
    return this.db.serialTxn((tx) => {
      this.mustCase(tx, caseId);
      runStmt(
        tx,
        `UPDATE penalty_entries SET status='locked'
         WHERE case_id=? AND kind='original' AND status='active'`,
        [caseId],
      );
      return this.penaltyChain(tx, caseId);
    });
  }

  /**
   * 追溯规则影响清单：扫描同类别全部立案，用追溯规则【只重算只读对比】，
   * 差异落为 impact_items；绝不修改案件快照、升级记录或处罚。
   * (retroactive_version_id, case_id, target) 唯一，重复生成幂等。
   */
  async generateImpact(retroRuleId: number) {
    return this.db.serialTxn((tx) => {
      const retro = queryOne(tx, `SELECT * FROM rule_versions WHERE id=?`, [retroRuleId]);
      if (!retro) throw Errors.notFound(`追溯规则 #${retroRuleId}`);
      if (Number(retro.is_retroactive) !== 1) {
        throw Errors.invalidState('仅 retroactive 规则可生成追溯影响清单');
      }
      if (String(retro.status) !== 'effective') {
        throw Errors.invalidState('追溯规则必须已生效才能生成影响清单');
      }
      const retroContent = validateContent(JSON.parse(String(retro.content_json)));

      const cases = queryAll(
        tx,
        `SELECT * FROM cases WHERE category_code=? ORDER BY occurred_at, id`,
        [retroContent.category_code],
      );
      const items: unknown[] = [];
      for (const c0 of cases) {
        const c = c0 as Record<string, number | string>;
        const caseId = Number(c.id);
        const occurred = new Date(String(c.occurred_at));
        // 追溯规则只影响其 effective_from 之前/当日的旧事件。
        if (
          retro.effective_from &&
          occurred.getTime() > new Date(String(retro.effective_from)).getTime()
        ) {
          continue;
        }
        const frozen = JSON.parse(String(c.rule_snapshot_json)) as RuleContent;
        const now = this.clock.now();
        // 冻结规则与追溯规则分别用各自的整改时限计算“截至现在的逾期小时数”，
        // 避免用新时限衡量旧快照造成假性差异。
        const frozenOverdue = Math.max(
          0,
          hoursBetween(String(c.occurred_at), now) - frozen.rectify_hours,
        );
        const retroOverdue = Math.max(
          0,
          hoursBetween(String(c.occurred_at), now) - retroContent.rectify_hours,
        );
        const retroTiers = tiersUpTo(retroContent, retroOverdue);
        const frozenTiers = tiersUpTo(frozen, frozenOverdue);
        const top = (arr: LadderTier[]) => arr[arr.length - 1];
        const retroTop = top(retroTiers);
        const frozenTop = top(frozenTiers);
        const differs =
          frozenTop.step !== retroTop.step ||
          frozenTop.score !== retroTop.score ||
          frozenTop.fine !== retroTop.fine ||
          frozen.rectify_hours !== retroContent.rectify_hours;
        if (!differs) continue;

        const hasLock = queryOne(
          tx,
          `SELECT 1 AS x FROM penalty_entries
           WHERE case_id=? AND kind='original' AND status='locked' LIMIT 1`,
          [caseId],
        );
        const target = hasLock ? 'locked_penalty' : 'frozen_case';
        const detail = {
          case_no: c.case_no,
          occurred_at: c.occurred_at,
          frozen_rule: { version_id: Number(c.rule_version_id), rectify_hours: frozen.rectify_hours },
          retroactive_rule: {
            version_id: retroRuleId,
            rectify_hours: retroContent.rectify_hours,
          },
          evaluated_at: now.toISOString(),
          overdue_hours_frozen: Math.round(frozenOverdue * 100) / 100,
          overdue_hours_retro: Math.round(retroOverdue * 100) / 100,
          frozen_top_tier: frozenTop,
          retroactive_top_tier: retroTop,
          locked_original_preserved: true,
        };
        try {
          const id = runStmt(
            tx,
            `INSERT INTO impact_items(retroactive_version_id, case_id, case_no, target,
                                      detail_json, status, created_at)
             VALUES (?,?,?,?,?, 'pending', ?)`,
            [retroRuleId, caseId, c.case_no, target, canonicalJson(detail), now.toISOString()],
          );
          items.push({ id, ...detail, target });
        } catch (e) {
          if (isUniqueViolation(e)) continue; // 已生成过：幂等跳过
          throw e;
        }
      }
      return { retroactive_version_id: retroRuleId, generated: items, count: items.length };
    });
  }

  listImpact(retroRuleId?: number, status?: string) {
    return this.db.read((tx) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (retroRuleId) {
        where.push('retroactive_version_id=?');
        params.push(retroRuleId);
      }
      if (status) {
        where.push('status=?');
        params.push(status);
      }
      return queryAll(
        tx,
        `SELECT * FROM impact_items ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY id`,
        params,
      ).map((r) => ({ ...r, detail: JSON.parse(String(r.detail_json)) }));
    });
  }

  /**
   * 确认影响清单条目：
   * - confirm：【追加】更正链。original（尤其已锁定）一律保留原样：
   *   * 差异每阶追加一条 correction 条目；
   *   * 同步追加一条 review 复核条目（指向原 original）。
   * - ignore：标记忽略，不产生任何台账变动。
   * 重复确认幂等：已处理的条目返回既有处理结果。
   */
  async confirmImpact(itemId: number, action: 'confirm' | 'ignore', reason?: string) {
    return this.db.serialTxn((tx) => {
      const item0 = queryOne(tx, `SELECT * FROM impact_items WHERE id=?`, [itemId]);
      if (!item0) throw Errors.notFound(`影响清单 #${itemId}`);
      const item = item0 as Record<string, number | string | null>;

      if (String(item.status) !== 'pending') {
        return { idempotent: true, item: this.decorateImpact(tx, itemId) };
      }
      if (action === 'ignore') {
        runStmt(tx, `UPDATE impact_items SET status='ignored' WHERE id=?`, [itemId]);
        return { idempotent: false, item: this.decorateImpact(tx, itemId) };
      }

      const detail = JSON.parse(String(item.detail_json));
      const caseId = Number(item.case_id);
      const retroId = Number(item.retroactive_version_id);
      const retroContent = parseContent(
        queryOne(tx, `SELECT * FROM rule_versions WHERE id=?`, [retroId])! as {
          content_json: string;
        },
      );
      const at = new Date(String(detail.evaluated_at));
      const overdue = Number(detail.overdue_hours_retro);
      const projectedTiers = tiersUpTo(retroContent, overdue);

      const added: number[] = [];
      for (const tier of projectedTiers) {
        // 每阶只追加一条 correction（impact_item_id,kind,step 唯一索引兜底）。
        try {
          const cid = runStmt(
            tx,
            `INSERT INTO penalty_entries
               (case_id, entry_code, kind, status, rule_version_id, step, score, fine, action,
                origin_entry_id, impact_item_id, reason, created_at)
             VALUES (?,?, 'correction', 'active', ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
            [
              caseId,
              `P-${String(item.case_no)}-I${itemId}-C${tier.step}`,
              retroId,
              tier.step,
              tier.score,
              tier.fine,
              tier.action,
              itemId,
              reason ??
                `追溯规则 #${retroId} 影响清单 #${itemId} 确认后追加更正（原锁定处罚保留不覆盖）`,
              at.toISOString(),
            ],
          );
          runStmt(
            tx,
            `UPDATE penalty_entries SET origin_entry_id=(
               SELECT id FROM penalty_entries WHERE case_id=? AND kind='original' AND step=? LIMIT 1
             ) WHERE id=?`,
            [caseId, tier.step, cid],
          );
          added.push(cid);
        } catch (e) {
          if (isUniqueViolation(e)) continue;
          throw e;
        }
      }

      // 复核条目：指向被追溯命中的 original 链（锁定处罚复核记录）。
      const originOriginal = queryOne(
        tx,
        `SELECT id FROM penalty_entries
         WHERE case_id=? AND kind='original'
         ORDER BY step DESC LIMIT 1`,
        [caseId],
      );
      let reviewId: number | null = null;
      try {
        reviewId = runStmt(
          tx,
          `INSERT INTO penalty_entries
             (case_id, entry_code, kind, status, rule_version_id, step, score, fine, action,
              origin_entry_id, impact_item_id, reason, created_at)
           VALUES (?,?, 'review', 'reviewed', ?, 0, 0, 0, ?, ?, ?, ?, ?)`,
          [
            caseId,
            `P-${String(item.case_no)}-I${itemId}-REVIEW`,
            retroId,
            `追溯复核：原处罚保持${String(item.target) === 'locked_penalty' ? '锁定' : '有效'}，更正见同链 correction 条目`,
            originOriginal ? Number(originOriginal.id) : null,
            itemId,
            reason ?? '追溯影响确认后系统追加复核',
            at.toISOString(),
          ],
        );
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
      }

      runStmt(
        tx,
        `UPDATE impact_items SET status='confirmed', confirmed_at=?,
             processed_penalty_entry_id=? WHERE id=?`,
        [this.clock.nowIso(), added[0] ?? reviewId, itemId],
      );
      return { idempotent: false, item: this.decorateImpact(tx, itemId), added_entries: added };
    });
  }

  private decorateImpact(tx: Database, id: number) {
    const r = queryOne(tx, `SELECT * FROM impact_items WHERE id=?`, [id])!;
    return { ...r, detail: JSON.parse(String(r.detail_json)) };
  }

  list(opts: { category?: string } = {}) {
    return this.db.read((tx) => {
      const rows = opts.category
        ? queryAll(tx, `SELECT * FROM cases WHERE category_code=? ORDER BY occurred_at, id`, [
            opts.category,
          ])
        : queryAll(tx, `SELECT * FROM cases ORDER BY occurred_at, id`);
      return rows.map((r) => this.shapeCase(r));
    });
  }

  detailById(caseId: number) {
    return this.db.read((tx) => this.detail(tx, caseId));
  }

  private detail(tx: Database, caseId: number) {
    const c = queryOne(tx, `SELECT * FROM cases WHERE id=?`, [caseId]);
    if (!c) throw Errors.notFound(`案件 #${caseId}`);
    return {
      ...this.shapeCase(c),
      escalations: queryAll(tx, `SELECT * FROM escalations WHERE case_id=? ORDER BY step`, [
        caseId,
      ]),
      penalty_chain: this.penaltyChain(tx, caseId),
      attachments: queryAll(tx, `SELECT * FROM attachments WHERE case_id=? ORDER BY kind, id`, [
        caseId,
      ]),
    };
  }

  private penaltyChain(tx: Database, caseId: number) {
    return queryAll(
      tx,
      `SELECT pe.*, rv.rule_code, rv.version_no, rv.is_retroactive
       FROM penalty_entries pe JOIN rule_versions rv ON rv.id=pe.rule_version_id
       WHERE pe.case_id=? ORDER BY
         CASE pe.kind WHEN 'original' THEN 0 WHEN 'correction' THEN 1 ELSE 2 END,
         pe.step, pe.id`,
      [caseId],
    );
  }

  /** 处罚详情 + 规则链：每个条目附带其依据版本与（原条目情况下）立案快照。 */
  penaltyDetail(caseId: number) {
    return this.db.read((tx) => {
      this.mustCase(tx, caseId);
      const chain = this.penaltyChain(tx, caseId) as Array<
        Row & { rule_code: string; version_no: number }
      >;
      const versions = new Map<number, Row>();
      for (const e of chain) {
        const vid = Number(e.rule_version_id);
        if (!versions.has(vid)) {
          versions.set(
            vid,
            queryOne(tx, `SELECT * FROM rule_versions WHERE id=?`, [vid])!,
          );
        }
      }
      const caseRow = queryOne(tx, `SELECT * FROM cases WHERE id=?`, [caseId])!;
      return {
        case_id: caseId,
        case_no: caseRow.case_no,
        frozen_rule_version_id: Number(caseRow.rule_version_id),
        snapshot: JSON.parse(String(caseRow.rule_snapshot_json)),
        calc_basis: JSON.parse(String(caseRow.calc_basis_json)),
        entries: chain.map((e) => ({
          ...e,
          rule_version: (() => {
            const v = versions.get(Number(e.rule_version_id))!;
            return {
              id: Number(v.id),
              rule_code: v.rule_code,
              version_no: Number(v.version_no),
              status: v.status,
              effective_from: v.effective_from,
              effective_to: v.effective_to,
              is_retroactive: Boolean(Number(v.is_retroactive)),
            };
          })(),
        })),
      };
    });
  }

  addAttachment(caseId: number, input: {
    kind: 'photo' | 'rectification' | 'contract';
    ref_no: string;
    title?: string;
    url?: string;
  }) {
    if (!['photo', 'rectification', 'contract'].includes(input.kind)) {
      throw Errors.validation('kind 必须为 photo/rectification/contract');
    }
    if (!input.ref_no) throw Errors.validation('ref_no 必填');
    return this.db.serialTxn((tx) => {
      this.mustCase(tx, caseId);
      const id = runStmt(
        tx,
        `INSERT INTO attachments(case_id, kind, ref_no, title, url, created_at)
         VALUES (?,?,?,?,?,?)`,
        [
          caseId,
          input.kind,
          input.ref_no,
          input.title ?? '',
          input.url ?? '',
          this.clock.nowIso(),
        ],
      );
      return queryOne(tx, `SELECT * FROM attachments WHERE id=?`, [id]);
    });
  }

  private mustCase(tx: Database, caseId: number) {
    const c = queryOne(tx, `SELECT * FROM cases WHERE id=?`, [caseId]);
    if (!c) throw Errors.notFound(`案件 #${caseId}`);
    return c;
  }

  private shapeCase(r: Row) {
    return {
      ...r,
      rule_snapshot: JSON.parse(String(r.rule_snapshot_json)),
      calc_basis: JSON.parse(String(r.calc_basis_json)),
    };
  }

  private insertOriginalPenalty(
    tx: Database,
    caseId: number,
    ruleId: number,
    tier: LadderTier,
    atIso: string,
  ) {
    const caseNo = queryOne(tx, `SELECT case_no FROM cases WHERE id=?`, [caseId])!.case_no;
    try {
      runStmt(
        tx,
        `INSERT INTO penalty_entries
           (case_id, entry_code, kind, status, rule_version_id, step, score, fine, action,
            origin_entry_id, impact_item_id, reason, created_at)
         VALUES (?,?, 'original', 'active', ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
        [caseId, `P-${String(caseNo)}-S${tier.step}`, ruleId, tier.step, tier.score, tier.fine, tier.action, atIso],
      );
    } catch (e) {
      if (isUniqueViolation(e)) return;
      throw e;
    }
  }
}
