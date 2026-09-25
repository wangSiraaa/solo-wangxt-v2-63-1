# 市容考核执法台账（规则版本闭环）

在既有 **立案 / 可注入时钟升级 / 处罚锁定** 之上，新增**可发布的规则版本闭环**：

- 规则状态机：`draft → validated → effective →（superseded | withdrawn）`
- 一切派生结果按 **事件发生时间**（`occurred_at`）解析规则窗口，而非立案/当前时间
- 立案瞬间 **冻结规则快照 + 计算依据**；后续升级始终按快照计算，新规则**不能静默重算**旧案件
- 已锁定处罚 **不可覆盖**；追溯（retroactive）规则只生成**影响清单**，经确认后**追加**
  `correction` 更正条目与 `review` 复核条目，原版原封保留
- 时间窗重叠、无效阶梯、试算失败一律拒绝且原台账完整保留
- 旧台账数据迁移为 **基准规则（BASELINE）**，照片 / 整改 / 合同 / 旧处罚归属可直接回归

## 技术栈

Node.js 20 + TypeScript（strict）+ Fastify + sql.js（WASM SQLite，无需原生编译）。
写操作经串行写事务（`BEGIN IMMEDIATE`）排队，配合 UNIQUE 索引保证并发不产生双记录。

## 运行

```bash
npm install
npm run migrate        # 可选：显式执行迁移（启动时也会自动跑）
npm start              # 默认 http://0.0.0.0:3000 ，OpenAPI 文档 /docs
DB_FILE=./data/x.sqlite PORT=3200 npm start
npm test               # 14 个验收测试
```

## 规则版本生命周期与 API

| 动作 | 接口 | 状态变化 |
| --- | --- | --- |
| 建草稿 | `POST /rules/drafts` | → `draft`（`validate_now=true` 可直接到 validated） |
| 校验 | `POST /rules/:id/validate` | `draft → validated`（结构 + 阶梯 + 窗口重叠预检） |
| 发布 | `POST /rules/:id/publish` | `validated → effective`，截断替代重叠窗口的前驱（→`superseded`） |
| 撤回 | `POST /rules/:id/withdraw` | → `withdrawn`（已有立案命中则拒绝；撤回未来规则时恢复前驱） |
| 试算 | `POST /rules/:id/trial` | **只读不落库**，在指定时点对事件时间投影阶梯 |

追溯规则：建草稿时 `retroactive=true`。它可发布为 effective，但 **不占用生效窗口、
不截断/替代任何常规规则、不参与正常事件解析**，仅用于 `POST /rules/:id/impact/generate`。

### 时间窗语义

- 窗口为半开区间 `[effective_from, effective_to)`；两端 `null` 分别表示 `-∞ / +∞`
- 发布未来规则（`effective_from` 在未来）会把现行规则右开口截断为该起点
- 发布更早的规则若与**已排期的未来规则**交叉 → `422 时间窗重叠`，要求先撤回/改期未来规则
- 同一时刻同类别有且仅有一条可解析规则；多重重叠直接 422，不做静默选择
- 重复发布同一版本幂等返回，同内容重复建档被唯一校验和拒绝

### 阶梯校验

- 必须含 `step=0` 基准档且 `after_hours=0`；`step` 连续、`after_hours` 严格递增
- 分数非负且单调不减（逾期不能减分）、罚款非负、动作非空
- 基准档的 `score/fine` 必须等于 `base_score/base_fine`

## 立案 / 升级 / 处罚

- `POST /cases`：按 `occurred_at` 解析规则，落库 `rule_version_id + rule_snapshot_json + calc_basis_json`，
  并生成 `step=0` 的 original 处罚
- `POST /escalations/run`：按注入时钟（`PUT /admin/clock`）扫描逾期阶梯；
  始终读案件快照；`(case_id,step)` 唯一索引保证重复/并发扫描无双记录；
  **已锁定原始处罚的案件只记 escalation 事实，不再新增 original 处罚**
- `POST /cases/:id/lock`：锁定全部 original（幂等）
- `GET /cases/:id/penalty-detail`：处罚详情 + **规则链**，每条 original/correction/review
  都附其依据版本与（原条目）冻结快照

## 追溯影响清单

1. `POST /rules/:id/impact/generate`（retroactive 规则）→ 逐案只读重算差异，写 `impact_items`
2. 确认前案件快照 / 升级 / 处罚**纹丝不动**
3. `POST /impacts/:id/confirm {"action":"confirm"}`：
   - 每个差异阶 **追加** 一条 `correction`（链接到原 original）
   - **追加** 一条 `review` 复核条目
   - 原 original（含 locked）保留原样、金额/状态/依据版本不变
4. `action:"ignore"` 仅标记忽略；重复确认/重复生成均幂等

冻结规则与追溯规则分别用各自 `rectify_hours` 计算逾期，避免用新时限制造假性差异。

## 数据迁移（`migrations/`）

- `001_core_schema`：全量新模型（规则版本、案件快照、升级、处罚追加链、影响清单、附件）
- `002_legacy_baseline`：旧表（`legacy_*`）+ 演示旧数据 → 为 ZSJ/LJL/XGZ 生成左开
  **基准规则 v1**，旧案按事件时间命中并冻结；照片/整改/合同迁入 `attachments`、
  旧处罚迁入 `penalty_entries(kind=original)`（旧系统 `locked=1` 的迁移后仍为 `locked`）
- 迁移可重入：固定基准 code、`case_no` 唯一、已迁移旧行跳过

## 验收（`npm test`）

1. 未来规则不影响旧事件；旧案升级按 24h 快照而非新规 12h
2. 追溯命中锁定处罚：原版保留 + 追加 correction/review，快照不被重算
3. 重复发布/并发升级不产生双记录；锁定后扫描不新增原始处罚
4. 时间窗重叠、无效阶梯、试算失败：原台账完整保留
5. 旧数据迁移为基准规则后照片/整改/合同/处罚归属直接回归，迁移幂等
