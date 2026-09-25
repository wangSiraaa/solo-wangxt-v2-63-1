import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import { CaseService } from '../domain/case-service.js';

export function registerCaseRoutes(app: FastifyInstance, deps: AppDeps): void {
  const service = new CaseService(deps.db, deps.clock, app.ruleService);

  app.get(
    '/cases',
    {
      schema: {
        tags: ['cases'],
        summary: '立案列表（每条含冻结的规则快照与计算依据）',
        querystring: {
          type: 'object',
          properties: { category: { type: 'string' } },
        },
      },
    },
    async (req) => {
      const q = req.query as { category?: string };
      return { cases: service.list({ category: q.category }) };
    },
  );

  app.post(
    '/cases',
    {
      schema: {
        tags: ['cases'],
        summary: '立案：按事件发生时间解析规则并冻结快照/计算依据',
        body: {
          type: 'object',
          required: ['category_code', 'occurred_at', 'location'],
          properties: {
            category_code: { type: 'string', pattern: '^[A-Z]{2,6}$' },
            occurred_at: { type: 'string', description: '事件发生时间（规则解析基准），非立案时间' },
            location: { type: 'string' },
            description: { type: 'string' },
            case_no: { type: 'string' },
          },
        },
      },
    },
    async (req) => {
      const detail = await service.file(req.body as never);
      return detail;
    },
  );

  app.get(
    '/cases/:id',
    {
      schema: {
        tags: ['cases'],
        summary: '案件详情（升级、处罚链、附件）',
        params: { type: 'object', properties: { id: { type: 'integer' } } },
      },
    },
    async (req) => {
      const { id } = req.params as { id: number };
      return service.detailById(id);
    },
  );

  app.post(
    '/escalations/run',
    {
      schema: {
        tags: ['cases'],
        summary:
          '时钟升级扫描：按注入时钟对未结案件生成逾期阶梯；始终按立案快照计算；重复/并发不产生双记录',
        body: {
          type: 'object',
          properties: {
            case_id: { type: 'integer' },
            at: { type: 'string', description: '显式指定扫描时点（默认当前时钟）' },
          },
        },
      },
    },
    async (req) => {
      const body = (req.body as { case_id?: number; at?: string }) ?? {};
      return service.runEscalationSweep(body);
    },
  );

  app.post(
    '/cases/:id/lock',
    {
      schema: {
        tags: ['cases'],
        summary: '锁定案件全部原始处罚（幂等；锁定后不可覆盖，只能追加更正/复核）',
        params: { type: 'object', properties: { id: { type: 'integer' } } },
      },
    },
    async (req) => {
      const { id } = req.params as { id: number };
      return { entries: await service.lockPenalties(id) };
    },
  );

  app.get(
    '/cases/:id/penalty-detail',
    {
      schema: {
        tags: ['cases'],
        summary: '处罚详情与规则链：original/correction/review 全条目及各自依据的规则版本',
        params: { type: 'object', properties: { id: { type: 'integer' } } },
      },
    },
    async (req) => {
      const { id } = req.params as { id: number };
      return service.penaltyDetail(id);
    },
  );

  app.post(
    '/cases/:id/attachments',
    {
      schema: {
        tags: ['cases'],
        summary: '追加照片/整改/合同归属',
        params: { type: 'object', properties: { id: { type: 'integer' } } },
        body: {
          type: 'object',
          required: ['kind', 'ref_no'],
          properties: {
            kind: { type: 'string', enum: ['photo', 'rectification', 'contract'] },
            ref_no: { type: 'string' },
            title: { type: 'string' },
            url: { type: 'string' },
          },
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: number };
      return service.addAttachment(id, req.body as never);
    },
  );

  app.post(
    '/rules/:id/impact/generate',
    {
      schema: {
        tags: ['impact'],
        summary: '追溯规则生成影响清单（只读对比，不改任何案件/处罚；重复生成幂等）',
        params: { type: 'object', properties: { id: { type: 'integer' } } },
      },
    },
    async (req) => {
      const { id } = req.params as { id: number };
      return service.generateImpact(id);
    },
  );

  app.get(
    '/impacts',
    {
      schema: {
        tags: ['impact'],
        summary: '影响清单查询',
        querystring: {
          type: 'object',
          properties: {
            retroactive_version_id: { type: 'integer' },
            status: { type: 'string', enum: ['pending', 'confirmed', 'ignored'] },
          },
        },
      },
    },
    async (req) => {
      const q = req.query as { retroactive_version_id?: number; status?: string };
      return { items: service.listImpact(q.retroactive_version_id, q.status) };
    },
  );

  app.post(
    '/impacts/:id/confirm',
    {
      schema: {
        tags: ['impact'],
        summary:
          '确认影响清单：追加 correction 更正条目与 review 复核条目，原锁定处罚保留；重复确认幂等',
        params: { type: 'object', properties: { id: { type: 'integer' } } },
        body: {
          type: 'object',
          required: ['action'],
          properties: {
            action: { type: 'string', enum: ['confirm', 'ignore'] },
            reason: { type: 'string' },
          },
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: number };
      const body = req.body as { action: 'confirm' | 'ignore'; reason?: string };
      return service.confirmImpact(id, body.action, body.reason);
    },
  );
}
