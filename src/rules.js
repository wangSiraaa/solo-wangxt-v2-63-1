'use strict';

const { badRequest, notFound, conflict, unprocessable } = require('./errors');
const { toIso, DAY_MS } = require('./clock');
const { keyOf } = require('./store');
const { generateImpacts } = require('./impacts');

const DEFAULT_RULE_CODE = 'city-appearance-standard';

/** 规则状态机：DRAFT → VALIDATED → EFFECTIVE → SUPERSEDED；DRAFT/VALIDATED/EFFECTIVE/SUPERSEDED → WITHDRAWN */
const STATUS = ['DRAFT', 'VALIDATED', 'EFFECTIVE', 'SUPERSEDED', 'WITHDRAWN'];

function mustGetRule(store, id) {
  const rule = store.get('rules', id);
  if (!rule) throw notFound('RULE_NOT_FOUND', `规则版本不存在: ${id}`);
  return rule;
}

/** 规则内容（类别分值 + 整改时限 + 逾期升级阶梯）结构校验，返回错误清单 */
function validatePayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return [{ path: 'payload', message: 'payload 必须为对象' }];
  }
  const cats = payload.categories;
  if (!Array.isArray(cats) || cats.length === 0) {
    errors.push({ path: 'payload.categories', message: '类别清单不能为空' });
  } else {
    const seen = new Set();
    cats.forEach((c, i) => {
      const p = `payload.categories[${i}]`;
      if (!c || typeof c !== 'object' || Array.isArray(c)) {
        errors.push({ path: p, message: '类别必须为对象' });
        return;
      }
      if (typeof c.code !== 'string' || !c.code.trim()) {
        errors.push({ path: `${p}.code`, message: '类别编码必填' });
      } else if (seen.has(c.code)) {
        errors.push({ path: `${p}.code`, message: `类别编码重复: ${c.code}` });
      } else {
        seen.add(c.code);
      }
      if (typeof c.name !== 'string' || !c.name.trim()) {
        errors.push({ path: `${p}.name`, message: '类别名称必填' });
      }
      if (!Number.isFinite(c.base_score) || c.base_score < 0) {
        errors.push({ path: `${p}.base_score`, message: '基准分值必须为非负数字' });
      }
      if (!Number.isInteger(c.rectify_days) || c.rectify_days <= 0) {
        errors.push({ path: `${p}.rectify_days`, message: '整改时限必须为正整数天数' });
      }
    });
  }
  const ladder = payload.ladder;
  if (!Array.isArray(ladder) || ladder.length === 0) {
    errors.push({ path: 'payload.ladder', message: '逾期升级阶梯不能为空' });
  } else {
    const levels = new Set();
    let prevOverdue = -1;
    const sorted = [...ladder].sort((a, b) => (a && a.level) - (b && b.level));
    for (const s of sorted) {
      const tag = s && typeof s === 'object' ? `level=${s.level}` : '?';
      const p = `payload.ladder[${tag}]`;
      if (!s || typeof s !== 'object' || Array.isArray(s)) {
        errors.push({ path: p, message: '阶梯档必须为对象' });
        continue;
      }
      if (!Number.isInteger(s.level) || s.level <= 0) {
        errors.push({ path: `${p}.level`, message: '级别必须为正整数' });
      } else if (levels.has(s.level)) {
        errors.push({ path: `${p}.level`, message: `级别重复: ${s.level}` });
      } else {
        levels.add(s.level);
      }
      if (!Number.isInteger(s.overdue_days) || s.overdue_days < 0) {
        errors.push({ path: `${p}.overdue_days`, message: '逾期天数阈值必须为非负整数' });
      } else if (s.overdue_days <= prevOverdue) {
        errors.push({
          path: `${p}.overdue_days`,
          message: '逾期天数阈值必须随级别严格递增（无效阶梯）',
        });
      } else {
        prevOverdue = s.overdue_days;
      }
      if (typeof s.action !== 'string' || !s.action.trim()) {
        errors.push({ path: `${p}.action`, message: '处置动作必填' });
      }
      if (!Number.isFinite(s.penalty_points) || s.penalty_points < 0) {
        errors.push({ path: `${p}.penalty_points`, message: '处罚分值必须为非负数字' });
      }
    }
  }
  return errors;
}

/** 生效时间窗校验 */
function validateWindow(input) {
  const errors = [];
  if (!input.effective_from) {
    errors.push({ path: 'effective_from', message: '生效起始时间必填' });
    return errors;
  }
  let from;
  try {
    from = new Date(toIso(input.effective_from)).getTime();
  } catch {
    errors.push({ path: 'effective_from', message: '生效起始时间格式非法' });
    return errors;
  }
  if (input.effective_to !== undefined && input.effective_to !== null) {
    let to;
    try {
      to = new Date(toIso(input.effective_to)).getTime();
    } catch {
      errors.push({ path: 'effective_to', message: '生效截止时间格式非法' });
      return errors;
    }
    if (to <= from) {
      errors.push({ path: 'effective_to', message: '生效截止时间必须晚于起始时间' });
    }
  }
  return errors;
}

/** 立案冻结用快照：完整复制规则版本与负载，后续升级只读快照 */
function snapshotOf(rule) {
  return structuredClone({
    id: rule.id,
    code: rule.code,
    version: rule.version,
    status: rule.status,
    effective_from: rule.effective_from,
    effective_to: rule.effective_to,
    retroactive: rule.retroactive === true,
    baseline: rule.baseline === true,
    payload: rule.payload,
  });
}

function createRule(store, idx, clock, input = {}) {
  const { code, version, effective_from, effective_to = null, payload, note = null } = input;
  if (typeof code !== 'string' || !code.trim()) {
    throw badRequest('RULE_CODE_REQUIRED', '规则代码必填');
  }
  if (!Number.isInteger(version) || version <= 0) {
    throw badRequest('RULE_VERSION_INVALID', '版本号必须为正整数');
  }
  const windowErrors = validateWindow({ effective_from, effective_to });
  if (windowErrors.length) {
    throw unprocessable('RULE_WINDOW_INVALID', '生效时间窗非法', windowErrors);
  }
  return store.tx(() => {
    const dup = store.lookup(idx.ruleCodeVersion, keyOf(code, '@v', version));
    if (dup) {
      throw conflict('DUPLICATE_RECORD', '同一规则代码与版本已存在，禁止重复建档', {
        existing_id: dup.id,
      });
    }
    const now = clock.now().toISOString();
    const rule = {
      id: store.nextId('rule'),
      code,
      version,
      status: 'DRAFT',
      retroactive: false,
      baseline: false,
      effective_from: toIso(effective_from),
      effective_to: effective_to === null ? null : toIso(effective_to),
      payload: payload ?? null,
      note,
      created_at: now,
      updated_at: now,
      validated_at: null,
      published_at: null,
      withdrawn_at: null,
      superseded_by: null,
    };
    store.assertUnique(idx.ruleCodeVersion, rule); // 并发兜底：唯一索引防双记录
    store.insert('rules', rule);
    return rule;
  });
}

/** 校验：DRAFT/VALIDATED → VALIDATED；失败抛 422，状态留痕不变、台账不动 */
function validateRule(store, idx, clock, id) {
  return store.tx(() => {
    const rule = mustGetRule(store, id);
    if (!['DRAFT', 'VALIDATED'].includes(rule.status)) {
      throw conflict('RULE_STATE_CONFLICT', `当前状态 ${rule.status} 不允许校验`);
    }
    const errors = [...validateWindow(rule), ...validatePayload(rule.payload)];
    if (errors.length) {
      throw unprocessable('RULE_VALIDATION_FAILED', '规则校验未通过', errors);
    }
    rule.status = 'VALIDATED';
    rule.validated_at = clock.now().toISOString();
    rule.updated_at = rule.validated_at;
    return rule;
  });
}

/**
 * 发布：VALIDATED → EFFECTIVE（幂等，重复发布返回原记录）。
 * - 非追溯：同代码时间窗不得重叠；仅允许“开口区间顺延替代”（旧版截断为已替代）。
 * - 追溯（effective_from 早于发布时刻）：允许与既有窗口重叠，但不参与解析，
 *   只生成影响清单，经确认后追加更正与复核，绝不静默重算既有台账。
 */
function publishRule(store, idx, clock, id) {
  return store.tx(() => {
    const rule = mustGetRule(store, id);
    if (rule.status === 'EFFECTIVE') {
      return { rule, idempotent: true, impacts: [] };
    }
    if (rule.status !== 'VALIDATED') {
      throw conflict('RULE_STATE_CONFLICT', `当前状态 ${rule.status} 不允许发布，需先校验通过`);
    }
    const payloadErrors = validatePayload(rule.payload);
    if (payloadErrors.length) {
      throw unprocessable('RULE_PAYLOAD_INVALID', '规则内容未通过校验，禁止发布', payloadErrors);
    }
    const now = clock.now();
    const nowIso = now.toISOString();
    const retroactive = new Date(rule.effective_from).getTime() < now.getTime();

    if (!retroactive) {
      const newFrom = new Date(rule.effective_from).getTime();
      const newTo = rule.effective_to === null ? Infinity : new Date(rule.effective_to).getTime();
      const siblings = store.where(
        'rules',
        (r) =>
          r.code === rule.code &&
          r.id !== rule.id &&
          r.retroactive !== true &&
          (r.status === 'EFFECTIVE' || r.status === 'SUPERSEDED')
      );
      for (const s of siblings) {
        const sFrom = new Date(s.effective_from).getTime();
        const sTo = s.effective_to === null ? Infinity : new Date(s.effective_to).getTime();
        const overlap = sFrom < newTo && newFrom < sTo;
        if (!overlap) continue;
        const cleanSuccession =
          s.status === 'EFFECTIVE' &&
          s.effective_to === null &&
          sFrom < newFrom &&
          newTo === Infinity;
        if (!cleanSuccession) {
          throw conflict('RULE_WINDOW_OVERLAP', '生效时间窗与既有版本重叠，发布被拒绝，原台账保持不变', {
            conflict_with: s.id,
            conflict_window: { effective_from: s.effective_from, effective_to: s.effective_to },
          });
        }
        s.effective_to = rule.effective_from;
        s.status = 'SUPERSEDED';
        s.superseded_by = rule.id;
        s.updated_at = nowIso;
      }
    }

    rule.status = 'EFFECTIVE';
    rule.retroactive = retroactive;
    rule.published_at = nowIso;
    rule.updated_at = nowIso;

    let impacts = [];
    if (retroactive) {
      impacts = generateImpacts(store, idx, clock, rule);
    }
    return { rule, idempotent: false, impacts };
  });
}

function withdrawRule(store, idx, clock, id) {
  return store.tx(() => {
    const rule = mustGetRule(store, id);
    if (rule.status === 'WITHDRAWN') {
      throw conflict('RULE_STATE_CONFLICT', '规则已撤回，不可重复操作');
    }
    rule.status = 'WITHDRAWN';
    rule.withdrawn_at = clock.now().toISOString();
    rule.updated_at = rule.withdrawn_at;
    return rule;
  });
}

/**
 * 按事件发生时间解析命中规则：
 * 仅 EFFECTIVE / SUPERSEDED 且非追溯的版本参与；左闭右开时间窗；
 * 同代码多命中取高版本；无命中时回退基准规则（baseline）。
 */
function resolveRule(store, code, eventTime) {
  const t = new Date(toIso(eventTime)).getTime();
  const usable = store.where(
    'rules',
    (r) =>
      (r.status === 'EFFECTIVE' || r.status === 'SUPERSEDED') &&
      r.retroactive !== true &&
      new Date(r.effective_from).getTime() <= t &&
      (r.effective_to === null || t < new Date(r.effective_to).getTime())
  );
  const pick = (list) =>
    [...list].sort((a, b) => {
      if (a.baseline !== b.baseline) return a.baseline ? 1 : -1;
      return b.version - a.version;
    })[0] || null;
  return pick(usable.filter((r) => r.code === code)) || pick(usable.filter((r) => r.baseline));
}

/** 单事件试算（纯函数，不落库） */
function simulateEvent(payload, event) {
  const { event_time, category } = event || {};
  const overdueDays = Number.isInteger(event?.overdue_days) ? event.overdue_days : 0;
  if (!event_time) {
    return { ok: false, error: { code: 'EVENT_TIME_REQUIRED', message: 'event_time 必填' } };
  }
  let eventAt;
  try {
    eventAt = new Date(toIso(event_time)).getTime();
  } catch {
    return { ok: false, error: { code: 'EVENT_TIME_INVALID', message: 'event_time 格式非法' } };
  }
  const cat = (payload.categories || []).find((c) => c.code === category);
  if (!cat) {
    return { ok: false, error: { code: 'UNKNOWN_CATEGORY', message: `未知类别: ${category}` } };
  }
  const deadline = new Date(eventAt + cat.rectify_days * DAY_MS).toISOString();
  const steps = [...payload.ladder]
    .sort((a, b) => a.level - b.level)
    .filter((s) => s.overdue_days <= overdueDays)
    .map((s) => ({ level: s.level, action: s.action, penalty_points: s.penalty_points }));
  return {
    ok: true,
    event_time: toIso(event_time),
    category: cat.code,
    base_score: cat.base_score,
    rectify_days: cat.rectify_days,
    deadline,
    overdue_days: overdueDays,
    steps,
    total_penalty_points: steps.reduce((sum, s) => sum + s.penalty_points, 0),
  };
}

/** 试算：对样例事件跑当前规则内容，永不写库；负载非法则整体 422 */
function trialRule(store, id, events) {
  const rule = mustGetRule(store, id);
  const errors = validatePayload(rule.payload);
  if (errors.length) {
    throw unprocessable('RULE_PAYLOAD_INVALID', '规则内容未通过校验，试算中止，台账未做任何变更', errors);
  }
  if (!Array.isArray(events) || events.length === 0) {
    throw badRequest('TRIAL_EVENTS_REQUIRED', '试算事件清单不能为空');
  }
  return {
    rule_version_id: rule.id,
    rule_status: rule.status,
    persisted: false,
    results: events.map((e) => simulateEvent(rule.payload, e)),
  };
}

function listRules(store, query = {}) {
  let rows = store.all('rules');
  if (query.code) rows = rows.filter((r) => r.code === query.code);
  if (query.status) rows = rows.filter((r) => r.status === query.status);
  return rows.sort((a, b) => (a.code + a.version).localeCompare(b.code + b.version));
}

module.exports = {
  DEFAULT_RULE_CODE,
  STATUS,
  mustGetRule,
  validatePayload,
  validateWindow,
  snapshotOf,
  createRule,
  validateRule,
  publishRule,
  withdrawRule,
  resolveRule,
  simulateEvent,
  trialRule,
  listRules,
};
