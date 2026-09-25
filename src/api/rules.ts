import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import { RuleService, serializeRule } from '../domain/rule-service.js';
import type { RuleStatus } from '../domain/types.js';

const ladderTierSchema = {
  type: 'object',
  required: ['step', 'after_hours', 'score', 'fine', 'action'],
  properties: {
    step: { type: 'integer', minimum: 0 },
    after_hours: { type: 'number', minimum: 0 },
    score: { type: 'number', minimum: 0 },
    fine: { type: 'number', minimum: 0 },
    action: { type: 'string', minLength: 1 },
  },
} as const;

const ruleContentSchema = {
  type: 'object',
  required: ['category_code', 'base_score', 'base_fine', 'rectify_hours', 'ladder'],
  properties: {
    category_code: { type: 'string', pattern: '^[A-Z]{2,6}$' },
    base_score: { type: 'number', minimum: 0 },
    base_fine: { type: 'number', minimum: 0 },
    rectify_hours: { type: 'number', exclusiveMinimum: 0 },
    ladder: { type: 'array', minItems: 1, items: ladderTierSchema },
  },
} as const;

export function registerRuleRoutes(app: FastifyInstance, deps: AppDeps): void {
  const service = new RuleService(deps.db, deps.clock);
  // 暴露给 case 路由共用同一实例（服务本身无状态，仅持有 db/clock）。
  app.decorate('ruleService', service);

  app.get(
    '/rules',
    {
      schema: {
        tags: ['rules'],
        summary: '规则版本列表',
        querystring: {
          type: 'object',
          properties: {
            category: { type: 'string' },
            status: { type: 'string', enum: ['draft', 'validated', 'effective', 'superseded', 'withdrawn'] },
          },
        },
      },
    },
    async (req) => {
      const q = req.query as { category?: string; status?: RuleStatus };
      return { versions: service.list(q).map(serializeRule) };
    },
  );

  app.get(
    '/rules/:id',
    {
      schema: {
        tags: ['rules'],
        summary: '规则版本详情',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      },
    },
    async (req) => {
      const { id } = req.params as { id: number };
      return serializeRule(service.get(id));
    },
  );

  app.post(
    '/rules/drafts',
    {
      schema: {
        tags: ['rules'],
        summary: '创建规则草稿（validate_now=true 时创建即校验通过）',
        body: {
          type: 'object',
          required: ['category_code', 'content'],
          properties: {
            category_code: { type: 'string', pattern: '^[A-Z]{2,6}$' },
            effective_from: { type: ['string', 'null'], description: 'ISO；常规规则缺省=立即，未来时间=未来规则' },
            retroactive: { type: 'boolean', default: false, description: '追溯规则：仅生成影响清单' },
            validate_now: { type: 'boolean', default: false },
            content: ruleContentSchema,
          },
        },
      },
    },
    async (req) => {
      const rule = await service.createDraft(req.body as never);
      return serializeRule(rule);
    },
  );

  app.post(
    '/rules/:id/validate',
    {
      schema: {
        tags: ['rules'],
        summary: '校验草稿（结构 + 阶梯 + 窗口重叠预检）；draft -> validated',
        params: { type: 'object', properties: { id: { type: 'integer' } } },
      },
    },
    async (req) => {
      const { id } = req.params as { id: number };
      const result = await service.validate(id);
      return { rule: serializeRule(result.rule), overlap_check: result.overlap_check };
    },
  );

  app.post(
    '/rules/:id/publish',
    {
      schema: {
        tags: ['rules'],
        summary:
          '发布校验通过的规则（validated -> effective）；常规规则截断替代重叠窗口的前驱；重复发布幂等',
        params: { type: 'object', properties: { id: { type: 'integer' } } },
        body: {
          type: ['object', 'null'],
          properties: {
            effective_from: { type: ['string', 'null'], description: '可指定未来时间发布未来规则' },
          },
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: number };
      const body = (req.body as { effective_from?: string | null }) ?? {};
      const result = await service.publish(id, body);
      return {
        rule: serializeRule(result.rule),
        superseded_version_ids: result.superseded,
        idempotent: result.idempotent,
      };
    },
  );

  app.post(
    '/rules/:id/withdraw',
    {
      schema: {
        tags: ['rules'],
        summary: '撤回规则（已有立案命中则拒绝）；撤回未来规则时恢复其前驱',
        params: { type: 'object', properties: { id: { type: 'integer' } } },
        body: {
          type: ['object', 'null'],
          properties: { reason: { type: 'string' } },
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: number };
      const body = (req.body as { reason?: string }) ?? {};
      const result = await service.withdraw(id, body.reason ?? '');
      return { rule: serializeRule(result.rule), restored_version_ids: result.restored };
    },
  );

  app.post(
    '/rules/:id/trial',
    {
      schema: {
        tags: ['rules'],
        summary: '试算（只读不落库）：在某时点对事件时间列表投影阶梯；失败不触碰台账',
        params: { type: 'object', properties: { id: { type: 'integer' } } },
        body: {
          type: 'object',
          required: ['at', 'event_times'],
          properties: {
            at: { type: 'string', description: '试算时点 ISO' },
            event_times: { type: 'array', minItems: 1, items: { type: 'string' } },
          },
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: number };
      const body = req.body as { at: string; event_times: string[] };
      return service.trial(id, body.at, body.event_times);
    },
  );
}

declare module 'fastify' {
  interface FastifyInstance {
    ruleService: RuleService;
  }
}
