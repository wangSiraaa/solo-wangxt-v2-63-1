'use strict';

const http = require('http');
const { Store, buildIndexes } = require('./store');
const { ApiError, badRequest } = require('./errors');
const rulesSvc = require('./rules');
const casesSvc = require('./cases');
const { runEscalation } = require('./escalation');
const { lockPenalty, getPenaltyDetail } = require('./penalties');
const { confirmImpact, dismissImpact, listImpacts } = require('./impacts');
const { runBaselineMigration } = require('./migration');
const { buildOpenApi } = require('./openapi');

/** 极简路由：method + 路径模板（:param） */
function compileRoutes(routes) {
  return routes.map(([method, path, handler]) => {
    const keys = [];
    const pattern = path
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) {
          keys.push(seg.slice(1));
          return '([^/]+)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    return { method, regex: new RegExp(`^${pattern}$`), keys, handler };
  });
}

function createApp({ clock, store = null, dbFile = null } = {}) {
  if (!clock) throw new Error('clock 必须注入（可注入时钟）');
  const finalStore = store || (dbFile ? Store.load(dbFile) : new Store());
  const idx = buildIndexes(finalStore);
  if (dbFile) finalStore.onCommit = () => finalStore.save(dbFile);

  const db = finalStore;

  const routes = compileRoutes([
    // 规则版本闭环：草稿 → 校验 → 发布 → 已替代/撤回；试算不落库
    ['POST', '/api/rules', ({ body }) => [201, rulesSvc.createRule(db, idx, clock, body)]],
    ['GET', '/api/rules', ({ query }) => [200, { data: rulesSvc.listRules(db, query) }]],
    ['GET', '/api/rules/:id', ({ params }) => [200, rulesSvc.mustGetRule(db, params.id)]],
    ['POST', '/api/rules/:id/validate', ({ params }) => [200, rulesSvc.validateRule(db, idx, clock, params.id)]],
    ['POST', '/api/rules/:id/publish', ({ params }) => [200, rulesSvc.publishRule(db, idx, clock, params.id)]],
    ['POST', '/api/rules/:id/withdraw', ({ params }) => [200, rulesSvc.withdrawRule(db, idx, clock, params.id)]],
    ['POST', '/api/rules/:id/trial', ({ params, body }) => [200, rulesSvc.trialRule(db, params.id, body.events)]],
    ['GET', '/api/rules/:id/impacts', ({ params }) => [
      200,
      { data: listImpacts(db, { rule_version_id: params.id }) },
    ]],
    // 立案 / 整改 / 照片 / 合同归属
    ['POST', '/api/contracts', ({ body }) => [201, casesSvc.createContract(db, clock, body)]],
    ['POST', '/api/cases', ({ body }) => [201, casesSvc.fileCase(db, idx, clock, body)]],
    ['GET', '/api/cases', ({ query }) => [200, { data: casesSvc.listCases(db, query) }]],
    ['GET', '/api/cases/:id', ({ params }) => [200, casesSvc.assembleCase(db, params.id)]],
    ['POST', '/api/cases/:id/photos', ({ params, body }) => [201, casesSvc.addPhoto(db, clock, params.id, body)]],
    ['POST', '/api/cases/:id/rectifications/submit', ({ params, body }) => [
      200,
      casesSvc.submitRectification(db, idx, clock, params.id, body),
    ]],
    // 可注入时钟升级
    ['POST', '/api/escalations/run', ({ body }) => [200, runEscalation(db, idx, clock, body || {})]],
    // 处罚锁定与规则链
    ['GET', '/api/penalties/:id', ({ params }) => [200, getPenaltyDetail(db, params.id)]],
    ['POST', '/api/penalties/:id/lock', ({ params }) => [200, lockPenalty(db, clock, params.id)]],
    // 影响清单：确认后追加更正与复核
    ['GET', '/api/impacts', ({ query }) => [200, { data: listImpacts(db, query) }]],
    ['POST', '/api/impacts/:id/confirm', ({ params, body }) => [
      200,
      confirmImpact(db, idx, clock, params.id, body || {}),
    ]],
    ['POST', '/api/impacts/:id/dismiss', ({ params, body }) => [
      200,
      dismissImpact(db, idx, clock, params.id, body || {}),
    ]],
    // 模型迁移：旧数据 → 基准规则
    ['POST', '/api/migrations/baseline', ({ body }) => [200, runBaselineMigration(db, idx, clock, body || {})]],
    // 元信息
    ['GET', '/openapi.json', () => [200, buildOpenApi()]],
    ['GET', '/health', () => [200, { status: 'ok' }]],
  ]);

  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      const payload = JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(payload);
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      const query = Object.fromEntries(url.searchParams.entries());
      let body = {};
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        const raw = await readBody(req);
        if (raw.trim()) {
          try {
            body = JSON.parse(raw);
          } catch {
            throw badRequest('BODY_NOT_JSON', '请求体不是合法 JSON');
          }
        }
      }
      for (const route of routes) {
        if (route.method !== req.method) continue;
        const m = route.regex.exec(url.pathname);
        if (!m) continue;
        const params = {};
        route.keys.forEach((k, i) => {
          params[k] = decodeURIComponent(m[i + 1]);
        });
        const [status, payload] = await route.handler({ params, query, body });
        return send(status, payload);
      }
      return send(404, {
        error: { code: 'ROUTE_NOT_FOUND', message: `未匹配路由: ${req.method} ${url.pathname}` },
      });
    } catch (err) {
      if (err instanceof ApiError) {
        return send(err.status, {
          error: { code: err.code, message: err.message, details: err.details },
        });
      }
      return send(500, { error: { code: 'INTERNAL_ERROR', message: err.message } });
    }
  });

  return { server, store: finalStore, idx, clock };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 5 * 1024 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

module.exports = { createApp };
