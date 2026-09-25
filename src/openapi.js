'use strict';

/**
 * OpenAPI 3.0 规范：覆盖规则版本闭环、立案、升级、处罚锁定、影响清单与模型迁移。
 * 由 GET /openapi.json 提供，scripts/export-openapi.js 可导出静态文件。
 */
function buildOpenApi() {
  const error = (desc) => ({
    description: desc,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  });
  const jsonBody = (schema, required = true) => ({
    required,
    content: { 'application/json': { schema } },
  });
  const jsonResp = (desc, schema) => ({
    description: desc,
    content: { 'application/json': { schema } },
  });
  const idParam = (name, desc) => ({
    name,
    in: 'path',
    required: true,
    description: desc,
    schema: { type: 'string' },
  });

  return {
    openapi: '3.0.3',
    info: {
      title: '市容考核规则版本闭环 API',
      version: '1.0.0',
      description: [
        '规则生命周期：DRAFT → VALIDATED → EFFECTIVE → SUPERSEDED / WITHDRAWN。',
        '立案按事件发生时间解析命中规则并冻结快照与计算依据；后续升级（可注入时钟）只读快照，新规则不得静默重算。',
        '追溯生效规则只生成影响清单，经确认后追加更正与复核；已锁定处罚不得覆盖。',
        '模型迁移将旧数据挂接到基准规则，既有照片、整改与合同归属保持可回归。',
      ].join('\n\n'),
    },
    servers: [{ url: '/' }],
    tags: [
      { name: 'rules', description: '规则版本闭环：草稿/校验/发布/撤回/试算' },
      { name: 'cases', description: '立案、整改、照片、合同归属' },
      { name: 'escalations', description: '可注入时钟的逾期升级' },
      { name: 'penalties', description: '处罚锁定与规则链' },
      { name: 'impacts', description: '追溯规则影响清单与更正复核' },
      { name: 'migrations', description: '模型迁移：旧数据 → 基准规则' },
    ],
    paths: {
      '/api/rules': {
        post: {
          tags: ['rules'],
          summary: '创建规则版本（草稿）',
          operationId: 'createRule',
          requestBody: jsonBody({ $ref: '#/components/schemas/RuleCreate' }),
          responses: {
            201: jsonResp('草稿创建成功', { $ref: '#/components/schemas/RuleVersion' }),
            400: error('参数非法'),
            409: error('同代码同版本已存在（DUPLICATE_RECORD）'),
            422: error('生效时间窗非法（RULE_WINDOW_INVALID）'),
          },
        },
        get: {
          tags: ['rules'],
          summary: '规则版本列表',
          operationId: 'listRules',
          parameters: [
            { name: 'code', in: 'query', schema: { type: 'string' } },
            {
              name: 'status',
              in: 'query',
              schema: { $ref: '#/components/schemas/RuleStatus' },
            },
          ],
          responses: { 200: jsonResp('规则列表', { $ref: '#/components/schemas/RuleList' }) },
        },
      },
      '/api/rules/{id}': {
        get: {
          tags: ['rules'],
          summary: '规则版本详情',
          operationId: 'getRule',
          parameters: [idParam('id', '规则版本 ID')],
          responses: {
            200: jsonResp('规则详情', { $ref: '#/components/schemas/RuleVersion' }),
            404: error('规则不存在'),
          },
        },
      },
      '/api/rules/{id}/validate': {
        post: {
          tags: ['rules'],
          summary: '校验规则（DRAFT/VALIDATED → VALIDATED）',
          description: '校验类别分值、整改时限与逾期升级阶梯；失败返回 422 且状态与台账保持不变。',
          operationId: 'validateRule',
          parameters: [idParam('id', '规则版本 ID')],
          responses: {
            200: jsonResp('校验通过', { $ref: '#/components/schemas/RuleVersion' }),
            409: error('状态机冲突（RULE_STATE_CONFLICT）'),
            422: error('校验未通过（RULE_VALIDATION_FAILED），原台账完整保留'),
          },
        },
      },
      '/api/rules/{id}/publish': {
        post: {
          tags: ['rules'],
          summary: '发布规则（VALIDATED → EFFECTIVE，幂等）',
          description: [
            '重复发布返回原记录，不产生双记录。',
            '非追溯发布：同代码时间窗重叠返回 409；开口区间自动顺延替代旧版（SUPERSEDED）。',
            '追溯发布（effective_from 早于发布时刻）：不参与解析，只生成影响清单。',
          ].join('\n\n'),
          operationId: 'publishRule',
          parameters: [idParam('id', '规则版本 ID')],
          responses: {
            200: jsonResp('发布结果（含追溯影响清单）', { $ref: '#/components/schemas/PublishResult' }),
            409: error('状态机冲突或时间窗重叠（RULE_WINDOW_OVERLAP），原台账完整保留'),
            422: error('规则内容非法'),
          },
        },
      },
      '/api/rules/{id}/withdraw': {
        post: {
          tags: ['rules'],
          summary: '撤回规则（→ WITHDRAWN）',
          operationId: 'withdrawRule',
          parameters: [idParam('id', '规则版本 ID')],
          responses: {
            200: jsonResp('撤回成功', { $ref: '#/components/schemas/RuleVersion' }),
            409: error('已撤回不可重复操作'),
          },
        },
      },
      '/api/rules/{id}/trial': {
        post: {
          tags: ['rules'],
          summary: '试算（不落库）',
          description: '对样例事件按当前规则内容试算立案与升级结果；失败返回 422，台账不做任何变更。',
          operationId: 'trialRule',
          parameters: [idParam('id', '规则版本 ID')],
          requestBody: jsonBody({ $ref: '#/components/schemas/TrialRequest' }),
          responses: {
            200: jsonResp('试算结果', { $ref: '#/components/schemas/TrialResult' }),
            400: error('试算事件清单为空'),
            422: error('规则内容未通过校验（RULE_PAYLOAD_INVALID），台账未变更'),
          },
        },
      },
      '/api/rules/{id}/impacts': {
        get: {
          tags: ['impacts'],
          summary: '某规则版本生成的影响清单',
          operationId: 'listRuleImpacts',
          parameters: [idParam('id', '规则版本 ID')],
          responses: { 200: jsonResp('影响清单', { $ref: '#/components/schemas/ImpactList' }) },
        },
      },
      '/api/contracts': {
        post: {
          tags: ['cases'],
          summary: '创建合同（归属）',
          operationId: 'createContract',
          requestBody: jsonBody({ $ref: '#/components/schemas/ContractCreate' }),
          responses: {
            201: jsonResp('合同创建成功', { $ref: '#/components/schemas/Contract' }),
            400: error('参数非法'),
          },
        },
      },
      '/api/cases': {
        post: {
          tags: ['cases'],
          summary: '立案（按事件发生时间解析规则并冻结快照）',
          operationId: 'fileCase',
          requestBody: jsonBody({ $ref: '#/components/schemas/CaseCreate' }),
          responses: {
            201: jsonResp('立案成功（含冻结快照与计算依据）', { $ref: '#/components/schemas/CaseDetail' }),
            400: error('参数非法'),
            422: error('无生效规则（NO_EFFECTIVE_RULE）或未知类别（UNKNOWN_CATEGORY）'),
          },
        },
        get: {
          tags: ['cases'],
          summary: '立案列表',
          operationId: 'listCases',
          parameters: [
            { name: 'status', in: 'query', schema: { type: 'string' } },
            { name: 'contract_id', in: 'query', schema: { type: 'string' } },
          ],
          responses: { 200: jsonResp('立案列表', { $ref: '#/components/schemas/CaseList' }) },
        },
      },
      '/api/cases/{id}': {
        get: {
          tags: ['cases'],
          summary: '立案详情（快照、计算依据、整改、照片、升级、处罚、合同归属）',
          operationId: 'getCase',
          parameters: [idParam('id', '立案 ID')],
          responses: {
            200: jsonResp('立案详情', { $ref: '#/components/schemas/CaseDetail' }),
            404: error('立案不存在'),
          },
        },
      },
      '/api/cases/{id}/photos': {
        post: {
          tags: ['cases'],
          summary: '登记照片（取证/整改）',
          operationId: 'addPhoto',
          parameters: [idParam('id', '立案 ID')],
          requestBody: jsonBody({ $ref: '#/components/schemas/PhotoCreate' }),
          responses: {
            201: jsonResp('照片登记成功', { $ref: '#/components/schemas/Photo' }),
            400: error('参数非法'),
            404: error('立案不存在'),
          },
        },
      },
      '/api/cases/{id}/rectifications/submit': {
        post: {
          tags: ['cases'],
          summary: '提交整改（幂等）',
          operationId: 'submitRectification',
          parameters: [idParam('id', '立案 ID')],
          requestBody: jsonBody({ $ref: '#/components/schemas/RectificationSubmit' }, false),
          responses: {
            200: jsonResp('整改后的立案详情', { $ref: '#/components/schemas/CaseDetail' }),
            404: error('立案不存在'),
          },
        },
      },
      '/api/escalations/run': {
        post: {
          tags: ['escalations'],
          summary: '运行逾期升级（可注入时钟，幂等）',
          description: '按立案冻结快照的阶梯补齐升级记录与处罚；重复或并发运行不产生双记录。',
          operationId: 'runEscalation',
          requestBody: jsonBody({ $ref: '#/components/schemas/EscalationRun' }, false),
          responses: { 200: jsonResp('本次新增升级记录', { $ref: '#/components/schemas/EscalationRunResult' }) },
        },
      },
      '/api/penalties/{id}': {
        get: {
          tags: ['penalties'],
          summary: '处罚详情（含规则链）',
          description: '规则链：冻结快照 → 升级 → 锁定 → 更正 → 复核，按序返回。',
          operationId: 'getPenalty',
          parameters: [idParam('id', '处罚 ID')],
          responses: {
            200: jsonResp('处罚详情', { $ref: '#/components/schemas/PenaltyDetail' }),
            404: error('处罚不存在'),
          },
        },
      },
      '/api/penalties/{id}/lock': {
        post: {
          tags: ['penalties'],
          summary: '锁定处罚（幂等）',
          description: '锁定后金额封存不可覆盖；追溯规则命中时只能经影响清单确认后追加更正与复核。',
          operationId: 'lockPenalty',
          parameters: [idParam('id', '处罚 ID')],
          responses: {
            200: jsonResp('锁定结果', { $ref: '#/components/schemas/LockResult' }),
            404: error('处罚不存在'),
          },
        },
      },
      '/api/impacts': {
        get: {
          tags: ['impacts'],
          summary: '影响清单列表',
          operationId: 'listImpacts',
          parameters: [
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['PENDING', 'CONFIRMED', 'DISMISSED'] } },
            { name: 'rule_version_id', in: 'query', schema: { type: 'string' } },
            { name: 'case_id', in: 'query', schema: { type: 'string' } },
          ],
          responses: { 200: jsonResp('影响清单', { $ref: '#/components/schemas/ImpactList' }) },
        },
      },
      '/api/impacts/{id}/confirm': {
        post: {
          tags: ['impacts'],
          summary: '确认影响项：追加更正与复核（幂等）',
          description: '原处罚金额保留不覆盖；确认后向处罚规则链追加 CORRECTION 与 REVIEW。',
          operationId: 'confirmImpact',
          parameters: [idParam('id', '影响项 ID')],
          requestBody: jsonBody({ $ref: '#/components/schemas/ImpactConfirm' }, false),
          responses: {
            200: jsonResp('确认结果（更正 + 复核）', { $ref: '#/components/schemas/ImpactConfirmResult' }),
            409: error('状态冲突（IMPACT_STATE_CONFLICT）'),
            404: error('影响项不存在'),
          },
        },
      },
      '/api/impacts/{id}/dismiss': {
        post: {
          tags: ['impacts'],
          summary: '驳回影响项',
          operationId: 'dismissImpact',
          parameters: [idParam('id', '影响项 ID')],
          requestBody: jsonBody({ $ref: '#/components/schemas/ImpactDismiss' }, false),
          responses: {
            200: jsonResp('驳回成功', { $ref: '#/components/schemas/Impact' }),
            409: error('状态冲突'),
          },
        },
      },
      '/api/migrations/baseline': {
        post: {
          tags: ['migrations'],
          summary: '模型迁移：旧数据挂接基准规则（可重复执行，幂等）',
          description: '查找或创建基准规则，为缺少规则快照的立案冻结基准快照；既有照片、整改与合同归属原样保留。',
          operationId: 'runBaselineMigration',
          requestBody: jsonBody({ $ref: '#/components/schemas/MigrationRequest' }, false),
          responses: { 200: jsonResp('迁移报告', { $ref: '#/components/schemas/MigrationReport' }) },
        },
      },
      '/health': {
        get: {
          summary: '健康检查',
          operationId: 'health',
          responses: { 200: jsonResp('正常', { type: 'object', properties: { status: { type: 'string' } } }) },
        },
      },
    },
    components: {
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                details: {},
              },
              required: ['code', 'message'],
            },
          },
        },
        RuleStatus: {
          type: 'string',
          enum: ['DRAFT', 'VALIDATED', 'EFFECTIVE', 'SUPERSEDED', 'WITHDRAWN'],
          description: '草稿 → 校验通过 → 已生效 → 已替代 / 撤回',
        },
        RulePayload: {
          type: 'object',
          required: ['categories', 'ladder'],
          properties: {
            categories: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                required: ['code', 'name', 'base_score', 'rectify_days'],
                properties: {
                  code: { type: 'string', description: '类别编码' },
                  name: { type: 'string', description: '类别名称' },
                  base_score: { type: 'number', minimum: 0, description: '类别基准分值' },
                  rectify_days: { type: 'integer', minimum: 1, description: '整改时限（天）' },
                },
              },
            },
            ladder: {
              type: 'array',
              minItems: 1,
              description: '逾期升级阶梯：逾期天数阈值随级别严格递增',
              items: {
                type: 'object',
                required: ['level', 'overdue_days', 'action', 'penalty_points'],
                properties: {
                  level: { type: 'integer', minimum: 1 },
                  overdue_days: { type: 'integer', minimum: 0 },
                  action: { type: 'string', description: '处置动作，如 警告/罚款/约谈' },
                  penalty_points: { type: 'number', minimum: 0 },
                },
              },
            },
          },
        },
        RuleCreate: {
          type: 'object',
          required: ['code', 'version', 'effective_from', 'payload'],
          properties: {
            code: { type: 'string', description: '规则代码，如 city-appearance-standard' },
            version: { type: 'integer', minimum: 1 },
            effective_from: { type: 'string', format: 'date-time' },
            effective_to: { type: 'string', format: 'date-time', nullable: true },
            payload: { $ref: '#/components/schemas/RulePayload' },
            note: { type: 'string', nullable: true },
          },
        },
        RuleVersion: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            code: { type: 'string' },
            version: { type: 'integer' },
            status: { $ref: '#/components/schemas/RuleStatus' },
            retroactive: { type: 'boolean', description: '追溯生效：不参与解析，只生成影响清单' },
            baseline: { type: 'boolean', description: '基准规则（模型迁移承接旧数据）' },
            effective_from: { type: 'string', format: 'date-time' },
            effective_to: { type: 'string', format: 'date-time', nullable: true },
            payload: { $ref: '#/components/schemas/RulePayload' },
            note: { type: 'string', nullable: true },
            created_at: { type: 'string', format: 'date-time' },
            validated_at: { type: 'string', format: 'date-time', nullable: true },
            published_at: { type: 'string', format: 'date-time', nullable: true },
            withdrawn_at: { type: 'string', format: 'date-time', nullable: true },
            superseded_by: { type: 'string', nullable: true },
          },
        },
        RuleList: {
          type: 'object',
          properties: { data: { type: 'array', items: { $ref: '#/components/schemas/RuleVersion' } } },
        },
        PublishResult: {
          type: 'object',
          properties: {
            rule: { $ref: '#/components/schemas/RuleVersion' },
            idempotent: { type: 'boolean', description: '是否重复发布（幂等返回）' },
            impacts: { type: 'array', items: { $ref: '#/components/schemas/Impact' } },
          },
        },
        TrialRequest: {
          type: 'object',
          required: ['events'],
          properties: {
            events: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                required: ['event_time', 'category'],
                properties: {
                  event_time: { type: 'string', format: 'date-time' },
                  category: { type: 'string' },
                  overdue_days: { type: 'integer', minimum: 0, default: 0 },
                },
              },
            },
          },
        },
        TrialResult: {
          type: 'object',
          properties: {
            rule_version_id: { type: 'string' },
            rule_status: { $ref: '#/components/schemas/RuleStatus' },
            persisted: { type: 'boolean', enum: [false], description: '试算永不落库' },
            results: { type: 'array', items: { type: 'object' } },
          },
        },
        ContractCreate: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
            contractor: { type: 'string' },
            valid_from: { type: 'string', format: 'date-time', nullable: true },
            valid_to: { type: 'string', format: 'date-time', nullable: true },
          },
        },
        Contract: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            contractor: { type: 'string', nullable: true },
            valid_from: { type: 'string', format: 'date-time', nullable: true },
            valid_to: { type: 'string', format: 'date-time', nullable: true },
          },
        },
        CaseCreate: {
          type: 'object',
          required: ['event_time', 'category'],
          properties: {
            event_time: { type: 'string', format: 'date-time', description: '事件发生时间（用于解析命中规则）' },
            category: { type: 'string' },
            description: { type: 'string', nullable: true },
            reporter: { type: 'string', nullable: true },
            contract_id: { type: 'string', nullable: true, description: '合同归属' },
            rule_code: { type: 'string', default: 'city-appearance-standard' },
          },
        },
        CaseDetail: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            case_no: { type: 'string' },
            event_time: { type: 'string', format: 'date-time' },
            category: { type: 'string' },
            status: { type: 'string', enum: ['FILED', 'ESCALATING', 'RECTIFIED'] },
            rule_version_id: { type: 'string' },
            rule_snapshot: { type: 'object', description: '立案时冻结的规则快照，后续升级只读该快照' },
            calc_basis: { type: 'object', description: '计算依据：解析时刻、命中规则、类别参数、整改期限' },
            deadline: { type: 'string', format: 'date-time' },
            rectified_at: { type: 'string', format: 'date-time', nullable: true },
            rectification: { $ref: '#/components/schemas/Rectification' },
            photos: { type: 'array', items: { $ref: '#/components/schemas/Photo' } },
            escalations: { type: 'array', items: { $ref: '#/components/schemas/Escalation' } },
            penalties: { type: 'array', items: { $ref: '#/components/schemas/Penalty' } },
            contract: { $ref: '#/components/schemas/Contract' },
          },
        },
        CaseList: {
          type: 'object',
          properties: { data: { type: 'array', items: { $ref: '#/components/schemas/CaseDetail' } } },
        },
        Rectification: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            case_id: { type: 'string' },
            deadline: { type: 'string', format: 'date-time' },
            status: { type: 'string', enum: ['PENDING', 'SUBMITTED'] },
            submitted_at: { type: 'string', format: 'date-time', nullable: true },
            late: { type: 'boolean', nullable: true },
          },
        },
        RectificationSubmit: {
          type: 'object',
          properties: {
            submitted_at: { type: 'string', format: 'date-time', description: '缺省取注入时钟当前时间' },
            note: { type: 'string', nullable: true },
          },
        },
        PhotoCreate: {
          type: 'object',
          required: ['url', 'kind'],
          properties: {
            url: { type: 'string' },
            kind: { type: 'string', enum: ['EVIDENCE', 'RECTIFICATION'] },
            taken_at: { type: 'string', format: 'date-time', nullable: true },
          },
        },
        Photo: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            case_id: { type: 'string' },
            url: { type: 'string' },
            kind: { type: 'string' },
            taken_at: { type: 'string', format: 'date-time', nullable: true },
          },
        },
        EscalationRun: {
          type: 'object',
          properties: { case_id: { type: 'string', nullable: true, description: '缺省扫描全部逾期立案' } },
        },
        EscalationRunResult: {
          type: 'object',
          properties: {
            run_at: { type: 'string', format: 'date-time', description: '注入时钟当前时间' },
            created: { type: 'array', items: { $ref: '#/components/schemas/Escalation' } },
          },
        },
        Escalation: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            case_id: { type: 'string' },
            level: { type: 'integer' },
            overdue_days: { type: 'integer' },
            action: { type: 'string' },
            penalty_points: { type: 'number' },
            rule_version_id: { type: 'string', description: '来自立案冻结快照' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        Penalty: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            case_id: { type: 'string' },
            escalation_id: { type: 'string' },
            amount: { type: 'number', description: '原始金额，封存不可覆盖' },
            status: { type: 'string', enum: ['OPEN', 'LOCKED'] },
            locked_at: { type: 'string', format: 'date-time', nullable: true },
          },
        },
        PenaltyDetail: {
          allOf: [
            { $ref: '#/components/schemas/Penalty' },
            {
              type: 'object',
              properties: {
                corrections_total: { type: 'number', description: '更正增量合计（不并入原金额）' },
                corrections: { type: 'array', items: { $ref: '#/components/schemas/Correction' } },
                reviews: { type: 'array', items: { $ref: '#/components/schemas/Review' } },
                rule_chain: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/ChainEntry' },
                  description: '规则链：RULE_SNAPSHOT → ESCALATION → LOCK → CORRECTION → REVIEW',
                },
              },
            },
          ],
        },
        ChainEntry: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            penalty_id: { type: 'string' },
            seq: { type: 'integer' },
            kind: { type: 'string', enum: ['RULE_SNAPSHOT', 'ESCALATION', 'LOCK', 'CORRECTION', 'REVIEW'] },
            ref_id: { type: 'string', nullable: true },
            note: { type: 'string' },
            at: { type: 'string', format: 'date-time' },
          },
        },
        LockResult: {
          type: 'object',
          properties: {
            penalty: { $ref: '#/components/schemas/Penalty' },
            idempotent: { type: 'boolean' },
          },
        },
        Impact: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            rule_version_id: { type: 'string' },
            case_id: { type: 'string' },
            penalty_id: { type: 'string' },
            kind: { type: 'string', enum: ['WOULD_CHANGE_PENALTY'] },
            status: { type: 'string', enum: ['PENDING', 'CONFIRMED', 'DISMISSED'] },
            detail: { type: 'object' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        ImpactList: {
          type: 'object',
          properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Impact' } } },
        },
        ImpactConfirm: {
          type: 'object',
          properties: {
            operator: { type: 'string', default: 'system' },
            note: { type: 'string', nullable: true },
          },
        },
        ImpactConfirmResult: {
          type: 'object',
          properties: {
            impact: { $ref: '#/components/schemas/Impact' },
            correction: { $ref: '#/components/schemas/Correction' },
            review: { $ref: '#/components/schemas/Review' },
            idempotent: { type: 'boolean' },
          },
        },
        ImpactDismiss: {
          type: 'object',
          properties: {
            operator: { type: 'string', default: 'system' },
            reason: { type: 'string', nullable: true },
          },
        },
        Correction: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            impact_id: { type: 'string' },
            penalty_id: { type: 'string' },
            delta: { type: 'number', description: '更正增量，原处罚金额不变' },
            created_by: { type: 'string' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        Review: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            correction_id: { type: 'string' },
            result: { type: 'string', enum: ['CONFIRMED'] },
            reviewer: { type: 'string' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        MigrationRequest: {
          type: 'object',
          properties: {
            payload: {
              $ref: '#/components/schemas/RulePayload',
              nullable: true,
              description: '自定义基准规则负载，缺省用内置基准',
            },
          },
        },
        MigrationReport: {
          type: 'object',
          properties: {
            baseline_rule_id: { type: 'string' },
            baseline_created: { type: 'boolean' },
            migrated_count: { type: 'integer' },
            migrated_case_ids: { type: 'array', items: { type: 'string' } },
            migrated_at: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
  };
}

module.exports = { buildOpenApi };
