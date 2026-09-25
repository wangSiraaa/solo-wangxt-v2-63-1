/**
 * 市容考核执法台账 —— 领域类型
 *
 * 规则版本生命周期：draft(草稿) -> validated(校验通过) -> effective(已生效)
 *                   effective -> superseded(已替代) / withdrawn(已撤回)
 *
 * 解析原则：所有派生结果一律按【事件发生时间】解析规则；
 * 立案时冻结规则快照，之后升级/处罚始终按快照计算，不被新规则静默重算。
 */

export type RuleStatus =
  | 'draft'        // 草稿
  | 'validated'    // 校验通过
  | 'effective'    // 已生效
  | 'superseded'   // 已替代
  | 'withdrawn';   // 已撤回

/** 逾期升级阶梯一档。step=0 为立案基准档；step>=1 为按 rectify_hours 边界触发的逾期档。 */
export interface LadderTier {
  /** 阶次：0 为立案基准；逾期阶次从 1 递增 */
  step: number;
  /** 触发该阶所需的逾期小时数下限（阶 0 固定 0）。 */
  after_hours: number;
  /** 该阶对考核类别的计分。 */
  score: number;
  /** 该阶处罚金额（元）。 */
  fine: number;
  /** 处置动作说明，如“责令整改”“加处罚款”“停业整顿”。 */
  action: string;
}

export interface RuleContent {
  category_code: string;
  base_score: number;
  base_fine: number;
  rectify_hours: number;
  ladder: LadderTier[];
}

export interface RuleVersion {
  id: number;
  rule_code: string;
  version_no: number;
  category_code: string;
  status: RuleStatus;
  /** 生效起（含），ISO 字符串；null 表示开放区间左端。 */
  effective_from: string | null;
  /** 生效止（不含）；null 表示开放区间右端，发布新规则时会被截断。 */
  effective_to: string | null;
  /** 追溯规则：只生成影响清单，不参与正常事件解析。 */
  is_retroactive: number;
  content_json: string;
  content_sha256: string;
  validated_at: string | null;
  published_at: string | null;
  superseded_by: number | null;
  created_at: string;
}

export interface CaseRecord {
  id: number;
  case_no: string;
  category_code: string;
  /** 事件发生时间（规则解析基准），不是立案时间。 */
  occurred_at: string;
  /** 立案时间。 */
  filed_at: string;
  location: string;
  description: string;
  status: 'open' | 'rectified' | 'closed';
  /** 立案时命中的规则版本，此后永不变更。 */
  rule_version_id: number;
  /** 冻结的规则内容快照（JSON 字符串）。 */
  rule_snapshot_json: string;
  /** 计算依据：命中窗口、基准分、整改时限、阶梯等，供复核回放。 */
  calc_basis_json: string;
  created_at: string;
}

export interface EscalationRecord {
  id: number;
  case_id: number;
  /** 依据的仍是立案快照，显式冗余记录以便审计。 */
  rule_version_id: number;
  step: number;
  score: number;
  fine: number;
  action: string;
  due_at: string;
  escalated_at: string;
}

export type PenaltyEntryKind = 'original' | 'correction' | 'review';
export type PenaltyEntryStatus = 'active' | 'locked' | 'corrected' | 'reviewed';

export interface PenaltyEntry {
  id: number;
  case_id: number;
  /** 原始/追加条目共同编号；original 条目 code 全局唯一。 */
  entry_code: string;
  /** original=原处罚（命中锁定处罚时必须保留）；correction=追溯确认后的更正；review=复核 */
  kind: PenaltyEntryKind;
  status: PenaltyEntryStatus;
  rule_version_id: number;
  step: number;
  score: number;
  fine: number;
  action: string;
  /** 更正/复核条目的来源链：correction 指向 impact_item，review 指向 original。 */
  origin_entry_id: number | null;
  impact_item_id: number | null;
  reason: string | null;
  created_at: string;
}

export type ImpactStatus = 'pending' | 'confirmed' | 'ignored';
export type ImpactTarget = 'frozen_case' | 'locked_penalty';

export interface ImpactItem {
  id: number;
  retroactive_version_id: number;
  case_id: number;
  case_no: string;
  target: ImpactTarget;
  /** frozen_case=该立案按追溯规则本应得到的计算依据；locked_penalty=锁定处罚与追溯结果的差异。 */
  detail_json: string;
  status: ImpactStatus;
  processed_penalty_entry_id: number | null;
  confirmed_at: string | null;
  created_at: string;
}

export interface AttachmentRecord {
  id: number;
  case_id: number;
  kind: 'photo' | 'rectification' | 'contract';
  ref_no: string;
  title: string;
  url: string;
  created_at: string;
}
