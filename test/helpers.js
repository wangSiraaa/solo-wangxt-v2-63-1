'use strict';

const assert = require('node:assert/strict');
const { createApp } = require('../src/http');
const { manualClock } = require('../src/clock');

/** 标准合法规则负载：两类别 + 三级阶梯 */
function validPayload(overrides = {}) {
  return {
    categories: [
      { code: 'LITTER', name: '暴露垃圾', base_score: 2, rectify_days: 3 },
      { code: 'POSTER', name: '违规张贴', base_score: 1, rectify_days: 2 },
    ],
    ladder: [
      { level: 1, overdue_days: 0, action: '警告', penalty_points: 0 },
      { level: 2, overdue_days: 3, action: '罚款', penalty_points: 5 },
      { level: 3, overdue_days: 7, action: '约谈', penalty_points: 10 },
    ],
    ...overrides,
  };
}

/** 启动一个注入手动时钟的应用实例，返回 api 助手 */
async function startApp(startIso = '2026-01-01T00:00:00.000Z') {
  const clock = manualClock(startIso);
  const app = createApp({ clock });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return {
    app,
    clock,
    api,
    close: () => new Promise((resolve) => app.server.close(resolve)),
  };
}

/** 创建 → 校验 → 发布，返回发布后的规则 */
async function makePublishedRule(api, input) {
  const created = await api('POST', '/api/rules', input);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const validated = await api('POST', `/api/rules/${created.body.id}/validate`);
  assert.equal(validated.status, 200, JSON.stringify(validated.body));
  const published = await api('POST', `/api/rules/${created.body.id}/publish`);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  return published.body;
}

/** 深快照当前台账（用于“失败时原台账完整保留”断言） */
function snapshotStore(store) {
  return structuredClone({ tables: store.tables, seqs: store.seqs });
}

function assertStoreEquals(store, snap, message) {
  assert.deepEqual(
    structuredClone({ tables: store.tables, seqs: store.seqs }),
    snap,
    message || '台账应与快照一致'
  );
}

module.exports = { validPayload, startApp, makePublishedRule, snapshotStore, assertStoreEquals };
