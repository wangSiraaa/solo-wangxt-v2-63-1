import { FastifyInstance } from 'fastify';
import { Db } from '../src/db.ts';
import { Clock } from '../src/domain/clock.ts';
import { runMigrations } from '../src/migrator.ts';
import { buildApp } from '../src/app.ts';

export interface Harness {
  app: FastifyInstance;
  db: Db;
  clock: Clock;
}

/** 每次用例使用独立的内存数据库并跑完所有迁移（含旧数据基准迁移）。 */
export async function makeApp(): Promise<Harness> {
  const db = await Db.open(':memory:');
  const clock = new Clock();
  await runMigrations(db, clock);
  const app = await buildApp({ db, clock });
  return { app, db, clock };
}

/** 建立一个带“有效阶梯”的新类别（不依赖迁移数据，隔离更干净）。 */
export async function seedCategory(app: FastifyInstance, code: string, name: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/admin/categories',
    payload: { code, name },
  });
  if (res.statusCode >= 400) throw new Error(`seed category failed: ${res.body}`);
}

export const LADDER_STD = {
  category_code: 'WGT',
  base_score: 2,
  base_fine: 200,
  rectify_hours: 24,
  ladder: [
    { step: 0, after_hours: 0, score: 2, fine: 200, action: '责令立即改正' },
    { step: 1, after_hours: 24, score: 5, fine: 500, action: '加处罚款' },
    { step: 2, after_hours: 72, score: 10, fine: 1000, action: '暂扣工具' },
  ],
};

export const LADDER_STRICT = {
  category_code: 'WGT',
  base_score: 2,
  base_fine: 300,
  rectify_hours: 12,
  ladder: [
    { step: 0, after_hours: 0, score: 2, fine: 300, action: '责令立即改正（更严）' },
    { step: 1, after_hours: 12, score: 6, fine: 600, action: '加处罚款（更严）' },
    { step: 2, after_hours: 48, score: 12, fine: 1200, action: '停业整顿' },
  ],
};

/** 草稿 -> 校验 -> 发布 的一条龙。 */
export async function publishRule(
  app: FastifyInstance,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const draft = await app.inject({
    method: 'POST',
    url: '/rules/drafts',
    payload: { validate_now: false, ...payload },
  });
  if (draft.statusCode >= 400) return { status: draft.statusCode, body: JSON.parse(draft.body) };
  const { id } = JSON.parse(draft.body);
  const val = await app.inject({ method: 'POST', url: `/rules/${id}/validate` });
  if (val.statusCode >= 400) return { status: val.statusCode, body: JSON.parse(val.body) };
  const pub = await app.inject({
    method: 'POST',
    url: `/rules/${id}/publish`,
    payload:
      payload.effective_from === undefined ? {} : { effective_from: payload.effective_from },
  });
  return { status: pub.statusCode, body: JSON.parse(pub.body) };
}

export function count(db: Db, sql: string): number {
  const rows = db.read((tx) => tx.exec(sql));
  return Number(rows[0]?.values[0][0] ?? 0);
}
