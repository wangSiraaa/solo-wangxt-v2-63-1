import crypto from 'node:crypto';
import type { LadderTier, RuleContent, RuleVersion } from './types.js';
import { Errors } from './errors.js';

const CATEGORY_RE = /^[A-Z]{2,6}$/;
const ACTION_MAX = 200;

/** 规范化的 JSON 串（键排序），保证同内容同校验和。 */
export function canonicalJson(obj: unknown): string {
  return JSON.stringify(sortKeys(obj));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

export function contentSha256(content: RuleContent): string {
  return crypto.createHash('sha256').update(canonicalJson(content)).digest('hex');
}

/**
 * 校验规则内容：
 * - 类别码合法；整改时限/基准分为非负数；基准罚款非负
 * - 阶梯必须含 step=0 基准档，after_hours=0，step 连续、after_hours 严格递增
 * - 每档分数非负且随逾期阶单调不减，罚款非负，动作非空
 *
 * 不合法时抛 VALIDATION_FAILED；合法时返回规范化（按 step 排序）内容。
 */
export function validateContent(input: unknown): RuleContent {
  if (!input || typeof input !== 'object') {
    throw Errors.validation('规则内容必须是对象');
  }
  const c = input as Partial<RuleContent>;
  if (typeof c.category_code !== 'string' || !CATEGORY_RE.test(c.category_code)) {
    throw Errors.validation('类别码必须为 2-6 位大写字母', { field: 'category_code' });
  }
  const baseScore = c.base_score;
  const baseFine = c.base_fine;
  const rectifyHours = c.rectify_hours;
  if (typeof baseScore !== 'number' || !Number.isFinite(baseScore) || baseScore < 0) {
    throw Errors.validation('基准分数必须为非负数', { field: 'base_score' });
  }
  if (typeof baseFine !== 'number' || !Number.isFinite(baseFine) || baseFine < 0) {
    throw Errors.validation('基准罚款必须为非负数', { field: 'base_fine' });
  }
  if (typeof rectifyHours !== 'number' || !Number.isFinite(rectifyHours) || rectifyHours <= 0) {
    throw Errors.validation('整改时限（小时）必须为正数', { field: 'rectify_hours' });
  }
  if (!Array.isArray(c.ladder) || c.ladder.length === 0) {
    throw Errors.validation('升级阶梯不能为空', { field: 'ladder' });
  }

  const tiers = [...c.ladder].sort((a, b) => a.step - b.step);
  let prev: LadderTier | null = null;
  for (const t of tiers) {
    if (!t || typeof t !== 'object') {
      throw Errors.validation('阶梯档必须为对象');
    }
    const expectedStep = prev ? prev.step + 1 : 0;
    if (t.step !== expectedStep) {
      throw Errors.validation(`阶梯 step 必须从 0 连续递增，期望 ${expectedStep}，实际 ${t.step}`, {
        field: 'ladder.step',
      });
    }
    if (!Number.isFinite(t.after_hours) || t.after_hours < 0) {
      throw Errors.validation(`第 ${t.step} 档 after_hours 必须为非负数`);
    }
    if (prev === null) {
      if (t.after_hours !== 0) {
        throw Errors.validation('基准档 step=0 的 after_hours 必须为 0');
      }
    } else if (t.after_hours <= prev.after_hours) {
      throw Errors.validation(
        `第 ${t.step} 档 after_hours(${t.after_hours}) 必须大于上一档(${prev.after_hours})，阶梯无效`,
      );
    }
    if (!Number.isFinite(t.score) || t.score < 0) {
      throw Errors.validation(`第 ${t.step} 档 score 必须为非负数`);
    }
    if (prev && t.score < prev.score) {
      throw Errors.validation(`第 ${t.step} 档 score 不得低于上一档（逾期升级不能减分）`);
    }
    if (!Number.isFinite(t.fine) || t.fine < 0) {
      throw Errors.validation(`第 ${t.step} 档 fine 必须为非负数`);
    }
    if (typeof t.action !== 'string' || !t.action.trim() || t.action.length > ACTION_MAX) {
      throw Errors.validation(`第 ${t.step} 档 action 必须为非空字符串且不超过 ${ACTION_MAX} 字`);
    }
    prev = t;
  }

  // 基准档必须与规则级基准一致，避免“内容自相矛盾”。
  const t0 = tiers[0];
  if (t0.score !== baseScore || t0.fine !== baseFine) {
    throw Errors.validation(
      '基准档（step=0）的 score/fine 必须与 base_score/base_fine 一致',
    );
  }

  return {
    category_code: c.category_code,
    base_score: baseScore,
    base_fine: baseFine,
    rectify_hours: rectifyHours,
    ladder: tiers.map((t) => ({
      step: t.step,
      after_hours: t.after_hours,
      score: t.score,
      fine: t.fine,
      action: t.action,
    })),
  };
}

export function parseContent(rule: Pick<RuleVersion, 'content_json'>): RuleContent {
  try {
    const parsed = JSON.parse(rule.content_json) as RuleContent;
    return parsed;
  } catch {
    throw Errors.validation('规则内容快照不是合法 JSON');
  }
}

/**
 * 给定规则与“已逾期小时数”，返回截至该时点应到达的最高阶。
 * 基准档 after_hours=0 永远命中；其余档 after_hours 为该阶触发的逾期下限。
 */
export function tierAtOverdue(content: RuleContent, overdueHours: number): LadderTier {
  let hit = content.ladder[0];
  for (const t of content.ladder) {
    if (overdueHours + 1e-9 >= t.after_hours) hit = t;
  }
  return hit;
}

/** 截至某逾期时点应触发的全部阶梯（含基准档）。 */
export function tiersUpTo(content: RuleContent, overdueHours: number): LadderTier[] {
  return content.ladder.filter((t) => overdueHours + 1e-9 >= t.after_hours);
}

export function hoursBetween(fromIso: string, to: Date): number {
  const from = new Date(fromIso).getTime();
  if (Number.isNaN(from)) throw Errors.validation('非法时间');
  return (to.getTime() - from) / 3_600_000;
}
