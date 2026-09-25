import Fastify, { type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { DomainError } from './domain/errors.js';
import type { Clock } from './domain/clock.js';
import type { Db } from './db.js';
import { registerRuleRoutes } from './api/rules.js';
import { registerCaseRoutes } from './api/cases.js';
import { registerAdminRoutes } from './api/admin.js';

export interface AppDeps {
  db: Db;
  clock: Clock;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { transport: undefined, level: process.env.LOG_LEVEL ?? 'warn' },
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DomainError) {
      void reply.status(err.httpStatus).send({
        error: { code: err.code, message: err.message, details: err.details },
      });
      return;
    }
    const maybeValidation = err as { validation?: unknown };
    if (maybeValidation.validation) {
      void reply.status(400).send({
        error: {
          code: 'REQUEST_VALIDATION',
          message: (err as Error).message,
          details: maybeValidation.validation,
        },
      });
      return;
    }
    app.log.error(err);
    void reply.status(500).send({ error: { code: 'INTERNAL', message: '服务器内部错误' } });
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: '市容考核执法台账 API',
        description:
          '规则版本闭环（草稿/校验通过/已生效/已替代/撤回）、按事件发生时间解析、' +
          '立案快照冻结、时钟驱动升级、处罚锁定与追溯更正链。',
        version: '1.0.0',
      },
      tags: [
        { name: 'rules', description: '规则版本：校验/发布/撤回/试算' },
        { name: 'cases', description: '立案、升级、处罚详情规则链、附件' },
        { name: 'impact', description: '追溯规则影响清单与确认追加更正' },
        { name: 'admin', description: '可注入时钟、类别维护' },
      ],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.get('/health', async () => ({ ok: true, now: deps.clock.nowIso() }));

  registerAdminRoutes(app, deps);
  registerRuleRoutes(app, deps);
  registerCaseRoutes(app, deps);

  return app;
}
