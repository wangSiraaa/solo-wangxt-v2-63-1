import type { FastifyInstance } from 'fastify';
import { runStmt, queryAll } from '../db.js';
import type { AppDeps } from '../app.js';

export function registerAdminRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db, clock } = deps;

  app.get(
    '/admin/clock',
    {
      schema: {
        tags: ['admin'],
        summary: '读取当前时钟（真实时间或注入时间）',
        response: { 200: { type: 'object', properties: { now: { type: 'string' } } } },
      },
    },
    async () => ({ now: clock.nowIso() }),
  );

  app.put(
    '/admin/clock',
    {
      schema: {
        tags: ['admin'],
        summary: '注入/恢复时钟（验收用）：now=null 恢复系统时钟',
        body: {
          type: 'object',
          required: ['now'],
          properties: { now: { type: ['string', 'null'], description: 'ISO 时间；null 恢复' } },
        },
      },
    },
    async (req) => {
      const body = req.body as { now: string | null };
      clock.setNow(body.now);
      return { now: clock.nowIso(), injected: body.now !== null };
    },
  );

  app.get(
    '/admin/categories',
    {
      schema: {
        tags: ['admin'],
        summary: '类别列表（含迁移而来的基准类别）',
      },
    },
    async () => db.read((tx) => queryAll(tx, `SELECT * FROM categories ORDER BY code`)),
  );

  app.post(
    '/admin/categories',
    {
      schema: {
        tags: ['admin'],
        summary: '建立考核类别',
        body: {
          type: 'object',
          required: ['code', 'name'],
          properties: {
            code: { type: 'string', pattern: '^[A-Z]{2,6}$' },
            name: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (req) => {
      const body = req.body as { code: string; name: string };
      return db.serialTxn((tx) => {
        runStmt(
          tx,
          `INSERT INTO categories(code, name, created_at) VALUES (?,?,?)
           ON CONFLICT(code) DO NOTHING`,
          [body.code, body.name, clock.nowIso()],
        );
        return {
          category: queryAll(tx, `SELECT * FROM categories WHERE code=?`, [body.code])[0],
        };
      });
    },
  );
}
