'use strict';

/** 影响清单（追溯规则 → 更正/复核）与 HTTP 基础行为测试 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { validPayload, startApp, makePublishedRule } = require('./helpers');

test('影响清单：驳回后不可确认；未命中处罚的追溯规则生成空清单', async () => {
  const { api, clock, close } = await startApp('2026-01-01T00:00:00.000Z');
  try {
    await makePublishedRule(api, {
      code: 'city-appearance-standard',
      version: 1,
      effective_from: '2026-01-01T00:00:00.000Z',
      payload: validPayload(),
    });
    // 立案但尚未产生处罚
    await api('POST', '/api/cases', { event_time: '2026-02-01T00:00:00.000Z', category: 'LITTER' });

    clock.set('2026-03-01T00:00:00.000Z');
    const retroPayload = validPayload();
    retroPayload.ladder[1].penalty_points = 8;
    const retro = await makePublishedRule(api, {
      code: 'city-appearance-standard',
      version: 2,
      effective_from: '2026-01-20T00:00:00.000Z',
      payload: retroPayload,
    });
    assert.equal(retro.rule.retroactive, true);
    assert.equal(retro.impacts.length, 0, '无处罚则影响清单为空');

    // 再制造一条处罚并生成影响项，验证驳回流
    clock.set('2026-03-20T00:00:00.000Z');
    await api('POST', '/api/escalations/run', {});
    const retro2Payload = validPayload();
    retro2Payload.ladder[1].penalty_points = 7;
    const retro2 = await makePublishedRule(api, {
      code: 'city-appearance-standard',
      version: 3,
      effective_from: '2026-01-25T00:00:00.000Z',
      payload: retro2Payload,
    });
    assert.equal(retro2.impacts.length, 1);
    const impactId = retro2.impacts[0].id;

    const dismissed = await api('POST', `/api/impacts/${impactId}/dismiss`, {
      operator: '审核员乙',
      reason: '经复核维持原处罚',
    });
    assert.equal(dismissed.body.status, 'DISMISSED');
    const confirmAfterDismiss = await api('POST', `/api/impacts/${impactId}/confirm`, {});
    assert.equal(confirmAfterDismiss.status, 409);
    assert.equal(confirmAfterDismiss.body.error.code, 'IMPACT_STATE_CONFLICT');

    // 处罚未被任何流程改动
    const cases = await api('GET', '/api/cases');
    const pen = cases.body.data[0].penalties[0];
    const pd = await api('GET', `/api/penalties/${pen.id}`);
    assert.equal(pd.body.amount, 5);
    assert.equal(pd.body.rule_chain.filter((e) => e.kind === 'CORRECTION').length, 0);
  } finally {
    await close();
  }
});

test('HTTP 基础：404、非法 JSON、健康检查与 OpenAPI 可达', async () => {
  const { api, app, close } = await startApp();
  try {
    const nf = await api('GET', '/api/nope');
    assert.equal(nf.status, 404);
    assert.equal(nf.body.error.code, 'ROUTE_NOT_FOUND');

    const missing = await api('GET', '/api/rules/rule-999');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'RULE_NOT_FOUND');

    const health = await api('GET', '/health');
    assert.equal(health.body.status, 'ok');

    const spec = await api('GET', '/openapi.json');
    assert.equal(spec.status, 200);
    assert.equal(spec.body.openapi, '3.0.3');
    for (const p of [
      '/api/rules',
      '/api/rules/{id}/publish',
      '/api/rules/{id}/trial',
      '/api/cases',
      '/api/escalations/run',
      '/api/penalties/{id}',
      '/api/penalties/{id}/lock',
      '/api/impacts/{id}/confirm',
      '/api/migrations/baseline',
    ]) {
      assert.ok(spec.body.paths[p], `OpenAPI 缺少路径 ${p}`);
    }

    // 非法 JSON 请求体 → 400
    const { port } = app.server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/rules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad json',
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'BODY_NOT_JSON');
  } finally {
    await close();
  }
});

test('无生效规则时立案返回 422，且不产生任何台账记录', async () => {
  const { api, app, close } = await startApp();
  try {
    const res = await api('POST', '/api/cases', {
      event_time: '2026-01-01T00:00:00.000Z',
      category: 'LITTER',
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'NO_EFFECTIVE_RULE');
    assert.equal(app.store.all('cases').length, 0);
    assert.equal(app.store.all('rectifications').length, 0);
  } finally {
    await close();
  }
});
