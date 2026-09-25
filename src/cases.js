'use strict';

const { badRequest, notFound, unprocessable } = require('./errors');
const { toIso, DAY_MS } = require('./clock');
const { resolveRule, snapshotOf, DEFAULT_RULE_CODE } = require('./rules');

function createContract(store, clock, input = {}) {
  const { name, contractor, valid_from = null, valid_to = null } = input;
  if (typeof name !== 'string' || !name.trim()) {
    throw badRequest('CONTRACT_NAME_REQUIRED', '合同名称必填');
  }
  return store.tx(() => {
    const now = clock.now().toISOString();
    const contract = {
      id: store.nextId('ct'),
      name,
      contractor: contractor || null,
      valid_from,
      valid_to,
      created_at: now,
    };
    return store.insert('contracts', contract);
  });
}

function mustGetCase(store, id) {
  const c = store.get('cases', id);
  if (!c) throw notFound('CASE_NOT_FOUND', `立案不存在: ${id}`);
  return c;
}

/**
 * 立案：按事件发生时间解析命中规则，冻结规则快照与计算依据。
 * 之后升级、处罚、影响比对一律读取该快照，新规则不得静默重算。
 */
function fileCase(store, idx, clock, input = {}) {
  const {
    event_time,
    category,
    description = null,
    reporter = null,
    contract_id = null,
    rule_code = DEFAULT_RULE_CODE,
  } = input;
  if (!event_time) throw badRequest('EVENT_TIME_REQUIRED', '事件发生时间必填');
  let eventAt;
  try {
    eventAt = toIso(event_time);
  } catch {
    throw badRequest('EVENT_TIME_INVALID', '事件发生时间格式非法');
  }
  if (typeof category !== 'string' || !category.trim()) {
    throw badRequest('CATEGORY_REQUIRED', '案件类别必填');
  }
  return store.tx(() => {
    if (contract_id !== null && !store.get('contracts', contract_id)) {
      throw unprocessable('CONTRACT_NOT_FOUND', `合同归属不存在: ${contract_id}`);
    }
    const rule = resolveRule(store, rule_code, eventAt);
    if (!rule) {
      throw unprocessable('NO_EFFECTIVE_RULE', '事件发生时间无生效规则，无法立案', {
        event_time: eventAt,
        rule_code,
      });
    }
    const cat = (rule.payload.categories || []).find((c) => c.code === category);
    if (!cat) {
      throw unprocessable('UNKNOWN_CATEGORY', `命中规则中不存在类别: ${category}`, {
        rule_version_id: rule.id,
      });
    }
    const now = clock.now().toISOString();
    const deadline = new Date(new Date(eventAt).getTime() + cat.rectify_days * DAY_MS).toISOString();
    const id = store.nextId('case');
    const caseRow = {
      id,
      case_no: `AJ-${id.replace('case-', '').padStart(6, '0')}`,
      event_time: eventAt,
      category,
      description,
      reporter,
      contract_id,
      status: 'FILED',
      rule_version_id: rule.id,
      rule_snapshot: snapshotOf(rule), // 冻结快照
      calc_basis: {
        // 计算依据：解析时刻、命中规则、类别参数与整改期限
        resolved_at: now,
        resolution: 'EVENT_TIME_WINDOW',
        rule: { id: rule.id, code: rule.code, version: rule.version },
        category: cat.code,
        base_score: cat.base_score,
        rectify_days: cat.rectify_days,
        deadline,
      },
      deadline,
      rectified_at: null,
      created_at: now,
    };
    store.insert('cases', caseRow);
    store.insert('rectifications', {
      id: store.nextId('rect'),
      case_id: id,
      deadline,
      status: 'PENDING',
      submitted_at: null,
      late: null,
      note: null,
    });
    return assembleCase(store, id);
  });
}

/** 提交整改：以注入时钟判定是否逾期；重复提交幂等返回现状 */
function submitRectification(store, idx, clock, caseId, input = {}) {
  return store.tx(() => {
    const caseRow = mustGetCase(store, caseId);
    const rect = store.where('rectifications', (r) => r.case_id === caseId)[0];
    if (!rect) throw notFound('RECTIFICATION_NOT_FOUND', `整改单不存在: ${caseId}`);
    if (rect.status === 'SUBMITTED') {
      return assembleCase(store, caseId); // 幂等
    }
    const submittedAt = input.submitted_at ? toIso(input.submitted_at) : clock.now().toISOString();
    rect.status = 'SUBMITTED';
    rect.submitted_at = submittedAt;
    rect.late = new Date(submittedAt).getTime() > new Date(rect.deadline).getTime();
    rect.note = input.note || null;
    caseRow.rectified_at = submittedAt;
    caseRow.status = 'RECTIFIED';
    return assembleCase(store, caseId);
  });
}

function addPhoto(store, clock, caseId, input = {}) {
  const { url, kind, taken_at = null } = input;
  if (typeof url !== 'string' || !url.trim()) {
    throw badRequest('PHOTO_URL_REQUIRED', '照片地址必填');
  }
  if (!['EVIDENCE', 'RECTIFICATION'].includes(kind)) {
    throw badRequest('PHOTO_KIND_INVALID', '照片类型须为 EVIDENCE 或 RECTIFICATION');
  }
  return store.tx(() => {
    mustGetCase(store, caseId);
    const photo = {
      id: store.nextId('photo'),
      case_id: caseId,
      url,
      kind,
      taken_at,
      created_at: clock.now().toISOString(),
    };
    return store.insert('photos', photo);
  });
}

/** 立案详情：案件 + 冻结快照 + 计算依据 + 整改 + 照片 + 升级 + 处罚 + 合同归属 */
function assembleCase(store, id) {
  const caseRow = mustGetCase(store, id);
  return {
    ...caseRow,
    rectification: store.where('rectifications', (r) => r.case_id === id)[0] || null,
    photos: store.where('photos', (p) => p.case_id === id),
    escalations: store
      .where('escalations', (e) => e.case_id === id)
      .sort((a, b) => a.level - b.level),
    penalties: store.where('penalties', (p) => p.case_id === id),
    contract: caseRow.contract_id ? store.get('contracts', caseRow.contract_id) : null,
  };
}

function listCases(store, query = {}) {
  let rows = store.all('cases');
  if (query.status) rows = rows.filter((c) => c.status === query.status);
  if (query.contract_id) rows = rows.filter((c) => c.contract_id === query.contract_id);
  return rows
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
    .map((c) => assembleCase(store, c.id));
}

module.exports = {
  createContract,
  mustGetCase,
  fileCase,
  submitRectification,
  addPhoto,
  assembleCase,
  listCases,
};
