# 市容考核规则版本闭环

在立案、可注入时钟升级、处罚锁定之上，实现**可发布的规则版本闭环**：规则经历
`草稿 → 校验通过 → 已生效 → 已替代 / 撤回` 的完整状态机，按事件发生时间解析命中版本；
立案时冻结规则快照与计算依据，后续升级只读快照，新规则不得静默重算；
已锁定处罚不得覆盖，追溯生效规则只生成影响清单，经确认后追加更正与复核。

零外部依赖（Node ≥ 18 内置 `node:http` / `node:test` / `structuredClone` / `fetch`）。

## 快速开始

```bash
npm start                 # 启动服务（PORT、DB_FILE 可选，DB_FILE 开启写穿持久化）
npm test                  # 18 个测试：5 条验收场景 + 单元测试
npm run openapi           # 导出 openapi.json（运行时亦可 GET /openapi.json）
node scripts/migrate.js --db data.json   # 可重复执行的模型迁移（幂等）
```

## 规则生命周期

```
DRAFT ──validate(ok)──▶ VALIDATED ──publish──▶ EFFECTIVE ──被新版顺延替代──▶ SUPERSEDED
   │                       │                        │
   └──────────┬───────────┴──────── withdraw ──────┴──────────▶ WITHDRAWN（终态）
```

- **校验**：类别分值非负、整改时限为正整数、阶梯级别唯一且逾期阈值严格递增；失败 422，状态与台账不变。
- **发布**：幂等（重复发布返回原记录）。非追溯发布要求同代码时间窗不重叠，
  仅支持“开口区间顺延替代”（旧版截断为 SUPERSEDED）；其余重叠 409，台账回滚。
- **追溯发布**（`effective_from` 早于发布时刻）：允许与既有窗口重叠，但**不参与解析**，
  只生成影响清单（`WOULD_CHANGE_PENALTY`），确认后追加更正与复核。
- **解析**：仅 `EFFECTIVE / SUPERSEDED` 且非追溯版本参与，窗口左闭右开；
  同代码多命中取高版本；无命中回退基准规则（baseline）。

## 不变式

1. **立案即冻结**：`rule_snapshot` + `calc_basis`（解析时刻、命中规则、类别参数、整改期限）
   随立案落库；升级引擎只读快照，未来规则不影响旧事件。
2. **处罚金额封存**：`penalty.amount` 创建后任何流程不得修改；锁定（LOCKED）幂等。
   追溯更正以独立 `corrections`（delta）+ `reviews` 记录追加，详情接口返回完整规则链
   （`RULE_SNAPSHOT → ESCALATION → LOCK → CORRECTION → REVIEW`）。
3. **幂等与并发**：`(code, version)`、`(case_id, level)`、`(escalation_id)`、
   `(rule, case, penalty, kind)`、`(impact_id)` 等唯一索引兜底，写路径为同步临界区，
   重复发布 / 并发升级 / 重复确认 / 重复迁移均不产生双记录。
4. **事务完整**：所有多写操作在 `store.tx` 快照事务内执行，任一步失败整体回滚——
   时间窗重叠、无效阶梯、试算失败、迁移失败时原台账完整保留。

## API 一览（详见 `openapi.json`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/rules` | 创建规则草稿（同代码同版本 409） |
| POST | `/api/rules/{id}/validate` | 校验 → VALIDATED（失败 422，台账不变） |
| POST | `/api/rules/{id}/publish` | 发布（幂等；重叠 409；追溯发布生成影响清单） |
| POST | `/api/rules/{id}/withdraw` | 撤回（终态） |
| POST | `/api/rules/{id}/trial` | 试算：样例事件演算，永不落库 |
| GET | `/api/rules/{id}/impacts` | 该版本生成的影响清单 |
| POST | `/api/cases` | 立案：按事件发生时间解析并冻结快照 |
| POST | `/api/cases/{id}/photos` | 取证/整改照片 |
| POST | `/api/cases/{id}/rectifications/submit` | 提交整改（幂等） |
| POST | `/api/contracts` | 合同归属 |
| POST | `/api/escalations/run` | 可注入时钟的逾期升级（幂等） |
| GET | `/api/penalties/{id}` | 处罚详情 + 规则链 |
| POST | `/api/penalties/{id}/lock` | 锁定处罚（幂等） |
| GET/POST | `/api/impacts` `/api/impacts/{id}/confirm` `/api/impacts/{id}/dismiss` | 影响清单确认/驳回 |
| POST | `/api/migrations/baseline` | 模型迁移：旧数据挂接基准规则（幂等） |

## 验收标准 ↔ 测试映射（`test/acceptance.test.js`）

| 验收标准 | 测试 |
| --- | --- |
| 未来规则不影响旧事件 | A：v2 未来生效后，旧事件仍解析 v1，升级按 v1 快照金额 |
| 回填规则命中锁定处罚保留原版并追加处理链 | B：锁定 5 分处罚，追溯规则生成影响清单，确认后链上追加更正+复核，金额不变 |
| 重复发布或并发升级不产生双记录 | C：重复发布幂等、并发 5 次升级仅 3 条记录 |
| 时间窗重叠、无效阶梯或试算失败时原台账完整保留 | D：409/422 前后台账深比较一致 |
| 旧数据迁移为基准规则后照片、整改、合同归属可回归 | E：迁移后详情回归 + 基准快照可升级 + 迁移幂等 |

## 目录

```
server.js              入口（PORT / DB_FILE）
src/clock.js           可注入时钟（system / manual）
src/store.js           台账 + 快照事务 + 唯一索引 + JSON 落盘
src/rules.js           规则状态机、校验、发布、解析、试算
src/cases.js           立案（冻结快照）、整改、照片、合同
src/escalation.js      升级引擎（读冻结快照，幂等）
src/penalties.js       处罚锁定、规则链
src/impacts.js         追溯影响清单、更正与复核
src/migration.js       基准规则迁移
src/http.js            路由与错误映射
src/openapi.js         OpenAPI 3.0 规范
scripts/migrate.js     可重复执行的迁移脚本
scripts/export-openapi.js
test/                  验收 + 单元测试（node:test）
```
