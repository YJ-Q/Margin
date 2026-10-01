# Margin 架构与接口梳理 + 业务流程统一方案

状态：**实施完成；历史结构图保留原始勘察时点**
日期：2026-09-26
方法：4 路代码勘察（持久层/HTTP 面/运行时与宿主/前端与评测）+ 现有 ADR 与架构文档比对。所有结论带文件路径证据。

**进度修订（2026-09-26）**：§4 已裁决。P0.6 的 Board、Contract gateway、Feishu 实际健康检查均返回 HTTP 200、统一形状与契约版本 1.2；构建通过。P2 的读取器现已接入默认 Board 与 Electron 宿主，Core 不可用时仍能打开 Board。P3 的 10 张表和 5 项独有功能均经用户决定仅归档，完整数据已本地导出并核对，旧 API 启动入口已关闭，见 `docs/audit/legacy_retirement_plan.md`。P0.5 的已清洗产物已入库、原始会话转储仍留本地；54 个已发布 handoff 的 manifest 元数据已重新核验并修复。

---

## 0. 结论摘要

1. **现在的 Margin 不是一个系统，是四条互不相交的调用图**，各自有自己的 HTTP 边界、自己的持久化、自己的"DTO"。它们之间没有任何一次调用。
2. **同一个业务概念被建模了两次**：Core 的 `Run`（`margin_runs`，有状态机、幂等、审计）和 Board 的 **Agent Session**（读外部 agent 的会话文件）指的是同一件现实事件——"某个 agent 在为某件事跑一轮"——但两者之间**没有连接**。这就是"业务流程不统一"的根源，不是文件组织问题。
3. **ADR 002 与当前默认表面直接冲突**：ADR 002 规定「任何 Surface 不得获取 repository / SQLite row / Pi Session 对象，必须经 `MarginApplicationContract`」；而当前 `npm start` 启动的 Board 表面在注释里明确写着"no SQLite core, no Application Contract"。两条都是仓库里已成文的立场。

---

## 1. 现状地图

### 1.1 四条互不相交的调用图

| # | 表面 | 入口 | 边界 | 状态 | 端点数 |
|---|---|---|---|---|---|
| A | Legacy REST | `scripts/run-legacy-api.js` → `src/server.js` → `src/app.js` | 直连 `src/services/*` → `src/storage/memoryStore.js` | **已弃用**，被 `MARGIN_ENABLE_LEGACY_API=true` 门住 | ~33 |
| B | Web Workbench Gateway | `scripts/run-web-workbench.js` → `src/web/createWebWorkbench.js` → `src/http/createWebHttpAdapter.js` | `MarginApplicationContract` 1.1 → `src/application/*` → `src/core/persistentWorkRepository.js` → margin-core.sqlite | **所谓"旧"，但它是唯一实现 ADR 002 的表面** | ~30 |
| C | Margin Board | `scripts/run-margin-surface.js` / `electron/main.js` → `src/core/handoff/createMarginSurface.js` → `httpAdapter.js` | 直接读 agent 会话文件 + `~/.margin/agent-sources.json` | **当前默认**（`npm start`） | 16 |
| D | Feishu | `scripts/run-feishu-surface.js` | `http.createServer` + 手写 `if (req.url)` 分支 → `src/core/createMarginCore.js` + `src/runtime/claude/claudeAgentLoop.js` | 活跃 | 3 |

四条图的交叉点：**零**。

- A 不 import 任何 `src/core/`、`src/application/`、`src/contracts/`
- B 不 import `src/core/handoff/`
- C 不 import `src/core/createMarginCore.js`（注释明确拒绝）
- D 是唯一同时使用 `createMarginCore` 和 Pi/Claude runtime 的表面，但它的路由是脚本里手写的 if/else，没有 router、没有契约校验

### 1.2 两套持久化，域重叠，互不可见

| 域 | Legacy（`memoryStore.js`，独立 sqlite） | Core（`marginCoreStore.js`，6 个 migration） |
|---|---|---|
| 记忆 | `user_states` | `margin_memories`（+ `margin_memory_embeddings`、lifecycle `archived_at`） |
| 行动 | `actions` | `margin_actions` |
| 决策 | `operation_proposals` | `margin_decisions` |
| 项目 | `user_states.project` | `margin_projects` / Workstream |
| 会话 | `conversations` | 无（会话在 agent 自己的目录里） |
| 事件 | `operation_events` | `margin_events` + cursor + `margin_audit_log` |
| 版本纪律 | 无（`CREATE TABLE IF NOT EXISTS`） | 有（checksum 校验的版本化 migration） |

**没有任何同步**。经 Feishu/Claude 写入的记忆（Core）在 legacy `/memory` 里看不见，反之亦然。这是当前最大的数据一致性风险，且用户无法从界面上知道自己在看哪一个。

### 1.3 前端：唯一能构建的 UI 只连 Board

- `web/vite.config.js` 只有 **一个** 构建入口：`margin: margin.html`
- `web/index.html`（Workbench）**存在但没有 vite 入口**，因此 `npm run build` 永远不产出它；`createWebWorkbench` 在非 dev 模式要求 `web/dist/index.html` → 该 UI 实际**只能在 vite dev server 下跑**
- 后果：**实现了 ADR 002 的那套 Application Contract，唯一的结构化 UI 无法构建。** 它的消费者只剩 CLI、终端 pilot、Feishu。

### 1.4 同一概念被建模两次（业务流程不统一的实质）

| 现实事件 | Core 里的建模 | Board 里的建模 | 连接 |
|---|---|---|---|
| agent 跑一轮 | `Run`（`margin_runs`，状态机 `RUN_STATUSES`，`runtimeReference`，host 授权，幂等） | Agent **Session**（`/api/sessions`，adapter 读会话文件，`executionStatus`） | **无** |
| 我做的一件事 | `Workstream` | Workspace（由 `cwd` 推出的 git 根，只做分组） | **无** |
| agent 是谁 | `WORKER_KINDS = ['pi','codex','other']`（`contractTypes.js`） | agent type（`codex`/`claude`/`pi` + plugin，descriptor taxonomy） | **无**（两套分类同名不同义） |
| 交接 | `Checkpoint` + `resume_brief.get` | `POST /api/handoff/generate`（生成 Markdown 给外部 agent 吃） | **无** |

四个都不连接。结果是：用户在 Board 上看到一个会话、在 Workbench 里看到一个 Run，系统无法回答"这个会话属于哪个工作流、它对应的 Run 是哪个"。

### 1.5 未纳入版本控制的资产（风险）

| 路径 | 文件数 | git 跟踪 | 风险 |
|---|---|---|---|
| `src/surfaces/feishu/**` | 12 | **0** | 整个飞书表面只在工作树里，`git clean -fd` 即永久丢失 |
| `experiments/**` | 35 | **0** | 同上 |
| `src/agents/descriptor/**` | 5 | **0** | 本轮重构成果 |
| `src/agents/agentInstall.js`、`plugins/**`、两个新 test | 5 | **0** | 同上 |
| `evaluation/**` | 11 | 11 | 已跟踪 ✓ |
| `web/src/margin/**`、`web/src/components/**` | 8 / 11 | 已跟踪 ✓ | |

### 1.6 零散的接口不一致

| 问题 | 证据 | 本轮状态 |
|---|---|---|
| `/api/health` 四种不同响应形状 | `createWebHttpAdapter.js:13`、`httpAdapter.js:221`、`app.js:38`、`run-feishu-surface.js:291` | **已修**：统一为 `src/surfaceHealth.js`，含 `surface` + `contractVersion` |
| 弃用文案已过期 | `scripts/run-legacy-api.js` 提示 "use npm start for the Web Workbench"，但 `npm start` 现在指向 Board | **已修** |
| docker 设了属于其他表面的 `PORT` | `docker-compose.yml` 设 `PORT=3000`（Surface B/legacy 的变量）而实际启动的是 Surface C。注：`MARGIN_SURFACE_HOST=0.0.0.0` 是容器内必需的，**不是问题** | **已修**（去掉 `PORT`，加注释说明 0.0.0.0 的原因） |
| Workbench UI 无法构建 | `vite.config.js` 只有 `margin.html` 一个入口 | **已修**：按决策删除旧 UI（见 ADR 003） |
| 契约版本无纪律 | `CONTRACT_VERSION='1.1'` 是常量，机制上不保证 `COMMAND_TYPES`/DTO 变化时递增 | **待 P4** |
| migration 版本与契约版本无关 | migration 4 名为 `margin-application-contract`，两套编号（1–6 vs 1.1）无形式关联 | **待 P4** |

---

## 2. 已成文的决策 vs 现状（必须正面处理的矛盾）

ADR 002（已接受，2026-08-24）原文：

> 任何 Surface 不得获取 repository、SQLite row、Pi Session 对象或 Runtime 私有事件。

当前默认表面（`httpAdapter.js` 顶部注释）原文：

> Deliberately not wired into `src/http/webGateway.js` — that gateway is bound to the old Workstream/Run/Memory Application Contract, and reusing it here would re-couple this Core to that business model.

`createMarginSurface.js` 同样写着："no SQLite core, no Application Contract, no Workstream/Run/Memory model"。

这两条立场都合理，但**不能同时为真**。需要一次显式裁决。注意 ADR 002 的原句里有一处关键线索：它禁止 Surface 获取 **Pi Session 对象**——也就是说，外部 agent 的会话本来就不在 Contract 的域内。这为 §4 的方案 B 提供了依据。

---

## 3. 问题清单（按修复价值排序）

| # | 问题 | 影响 | 证据 |
|---|---|---|---|
| P1 | 两套持久化、域重叠、无同步 | 数据正确性；用户不知道自己在看哪个库 | §1.2 |
| P2 | Run 与 Agent Session 无连接 | 业务流程无法统一；无法回答"这个会话属于哪个工作流" | §1.4 |
| P3 | 实现 ADR 002 的唯一 UI 无法构建 | 契约层缺少消费方，易腐化 | `web/vite.config.js` 单入口 |
| P4 | 整个飞书表面未纳入 git | 一次 `git clean` 永久丢失 | `git ls-files src/surfaces` = 0 |
| P5 | 四套 HTTP 边界各自定义契约 | 每个新功能要在多处重复；健康检查等基础接口都不一致 | §1.1 / §1.6 |
| P6 | `WORKER_KINDS` 与 agent type 同名不同义 | 阅读与 lint 陷阱；新人必然误解 | `contractTypes.js` vs `descriptor/builtin.js` |
| P7 | 契约版本无纪律 | 契约漂移无告警 | `CONTRACT_VERSION='1.1'` 常量 |
| P8 | legacy 表面仍可启动且数据未分类 | 冻结文档已要求导出/分类/归档，尚未执行 | `docs/architecture/v1_minimum_incremental_architecture.md` |

---

## 4. 岔口已裁决：方案 B — 两个有界 Context + 显式 bridge

**决策（2026-09-26，已记录为 [ADR 003](adr/003-surface-and-state-ownership.md)）**：

- **Core Context（Margin 拥有的持久状态）**：Workstream / Run / Artifact / Checkpoint / Memory / Decision / Event。唯一 owner，只经 `MarginApplicationContract`。
- **Runtime Context（外部 agent 的既有事实，只读）**：Agent Session / transcript / quota / agent source。Margin 不拥有它们，只读。
- **bridge**：`run.bindSession` / `session.resolveRun`，落在 `Run.runtimeReference`（ADR 002 已经规定「Pi / Codex 等 ID 只出现在 `runtimeReference`」）。
- **不可协商的纪律**：Runtime Context 只读。任何需要**写** Margin 拥有状态的路径必须经 Application Contract；Runtime adapter 不得直接写 SQLite、不得缓存可写状态。

**一并裁决的两件事**：

1. **旧 Workbench UI 删除，契约层保留。** 删除前确认：Contract 有 **20 个不经过 UI 的测试文件**在覆盖（`applicationContract*`、`phase2a*`、`runControl`、`memoryLifecycle`、`webbHttpAdapter`、`webGateway`、`webWorkbenchComposition` 等），因此删掉的 11 个 UI 测试只损失渲染层覆盖，契约行为不受影响。
2. **未跟踪资产入库**（见 P0）。

### 备选方案 A（未采纳，留作记录）

把 Board 的 `sessions`/`resources`/`agent-sources`/`handoff` 全部改为 Contract 的 command/query。字面符合 ADR 002，但要为外部文件系统造一个 file-backed repository，且与 ADR 002「不得获取 Pi Session 对象」那条存在天然张力，需要一次 Contract 大版本。

---

## 5. 后续计划

每阶段独立可验收，不依赖后续阶段。

### P0 — 止血

1. ✅ **代码与架构文档已入库**（commit `f0f37a9`）：`src/surfaces/feishu/**`、`src/agents/descriptor/**`、`src/agents/agentInstall.js`、`plugins/**`、两个新 test、`docs/architecture/**`。
2. ✅ **已清洗的证据产物入库，原始会话转储留本地**，见下方 P0.5。
3. ✅ 统一 `/api/health` 为一种形状（含 `surface` + `contractVersion` + `name`）
4. ✅ 修 `run-legacy-api.js` 过期文案；`docker-compose.yml` 去掉属于其他表面的 `PORT`（并注明容器内 `0.0.0.0` 是必需的，不是问题）
5. ✅ 旧 Workbench UI 删除（ADR 003），`createWebWorkbench` 改为 API-only

### P0.5 — 隐私守卫漏洞与证据树清洗 ✅

**守卫漏洞（已修）**：`test/repositoryPrivacy.test.js` 原来只匹配单反斜杠/斜杠形态，而机器生成的证据是 JSON，路径写作 `C:\\Users\\<user>`（分隔符全部转义）。该形态**两个模式都不命中**，于是一个含真实用户名的文件可以**通过守卫并被提交** —— 假绿，比没有守卫更糟，因为它被信任。

证据：`docs/validation/recovery-handoffs-r7-full/manifest.json` 既含 `C:\\Users\\<user>\\.codex\\...`，旧规则命中 **0 次**，转义形态命中 **12 次**。

已修：新增解码投影后再扫一遍，并把捕获段收紧为像账号名的字符集（否则会误报 `electron/main.js` 里给用户输出做脱敏的正则）。修复后立刻暴露 2 处真实泄漏：`forge.config.cjs` 注释、以及已提交的 `experiments/**`（10 个文件）—— 两处已处理。

**证据树现状（`docs/validation/` 未跟踪部分）**：

| | |
|---|---|
| 含真实家目录路径 | 67 个文件（守卫修好后才看得见） |
| 被 freeze manifest 的 SHA-256 绑定 | 55 个 handoff 输出 |
| 原始会话转储 | 29 个 `.jsonl`，58.8 MB，跨轮次重复 |

**后续处置**：已清洗的 handoff 与 manifest 已入库；原始会话 `.jsonl` 保持本地且被 `.gitignore` 排除。再次核验发现 12 个基线 handoff 的 manifest 哈希以及 42 个后续 handoff 的字节数元数据过期；已按当前入库文件修复 54 条记录。`scripts/verify-validation-manifests.js` 与测试现在持续核对哈希、字节数及压缩比例，不读取或提交原始会话正文。

**结论修正**：先前「未跟踪资产全部入库」的判断基于一个不可信的守卫，实际可安全入库的只有代码、插件与架构文档。

### P0.6 — 完成 P0 剩余项 ✅

验收：`npm start`、`npm run build`、`npm run legacy:workbench`、`npm run feishu` 四个入口的健康检查形状一致；`git ls-files src/surfaces` > 0。

### P1 — 裁决 §4 并记录 ADR

产出 `docs/architecture/adr/003-surface-and-state-ownership.md`，写清：Context 划分、bridge 归属、只读纪律、`WORKER_KINDS` 的处置。

验收：ADR 合并；`httpAdapter.js` 顶部那段"不接 Application Contract"的注释改写为指向 ADR 003（要么是"有界 context 二"，要么是"待合并"），不再留一个与 ADR 002 矛盾的孤立立场。

### P2 — 统一业务流程：Session ↔ Run bridge ✅ 已完成

| | |
|---|---|
| Command | `run.bind_session`（`sessionCanonicalId: null` 即解绑） |
| Query | `session.resolve_runs`（批量 1–100，非初稿的单数形式） |
| Migration | 007 `run-session-binding`：新列 + **partial unique index**（一个 session 最多属于一个 Run） |
| DTO | `runtimeReference.canonicalSessionId`，**只在绑定后出现**，未绑定形状不变 |
| Board | `createHandoffHttpAdapter({ resolveRuns })` —— 可选**注入**读取器，Runtime Context 不访问 Core |
| CLI | `margin run bind\|unbind\|resolve` |
| 测试 | `test/runSessionBridge.test.js`（7 条，含真实关闭重开与跨进程 CLI） |

验收已通过：绑定存盘并在重启后读回；Board 注入 resolver 时显示 `runId`/`workstreamId`，未注入或 resolver 抛错时降级为 `null` 且不影响 session 列表。

**后续进度**：默认 Board 和 Electron 宿主现通过 Contract-backed reader 注入 `resolveRuns`；查询按每批最多 100 个会话执行。Core 不可用时降级为未绑定显示，不阻止 Board 启动。Electron 打包时默认将 Core 放在可写的 userData 目录；显式设置 `MARGIN_CORE_DB_PATH` 可指向同一个既有 Core。

**实施量化出来的新输入（给 P4）**：给 Contract 加一个类型要改五处，而它们出错时表现不同：

| 处 | 漏改的后果 |
|---|---|
| `contracts/contractTypes.js` | 类型不存在（响亮） |
| `contracts/validation.js` | `invalid_request`（响亮） |
| `marginApplicationContract.js` 的 capability map / handler / `KNOWN_ERROR_CODES` | 能力缺失响亮；**错误码漏加则静默降级为 `storage_failure`** |
| `http/webCapabilities.js` | **启动即抛**（好护枢，应推广） |
| `persistentWorkRepository.js` 的 event→audit `CASE` 白名单 | **静默**：事件在 activity 投影里 join 失败，不报错 |

另：错误信封**不含 message**（ADR 002 禁止泄内文），所以需要上下文的错误码必须走结构化 `details`（如同 `version_conflict` 的 `currentVersion`）。

### P3 — 退役 legacy ✅ 数据与功能已归档，旧 API 启动入口已关闭

产出 `docs/audit/legacy_retirement_plan.md`：

- **只读清单复核**：10 表行数与 Phase 1 完全一致，并新增文件哈希（`1f565309…`）与 schema 哈希（`4c4fc799…`），使「未改动」从断言变成可复核证据
- **功能处置**：Management proposals、Achievements、Learning、Summaries、TTS 已决定归档、不移植；旧入口已关闭，历史源码仍保留
- **可执行的冻结**：`test/legacyRetirement.test.js` 从每个当前入口做**静态 import 图遍历**，断言不可达 `src/app.js` / `src/routes/**` / `src/services/**` / `src/storage/memoryStore.js`；断言旧 API 入口即使带旧 opt-in 标志也不监听；断言 `data/echo.sqlite` 保留且本文覆盖全部 10 张表

### P4 — 接口收敛 ✅ 完成

1. ✅ `docs/architecture/interface-registry.md`：两个 Context、四个 HTTP 表面全部端点、Contract 类型面（含 capability）、CLI、错误码；由 `test/interfaceRegistry.test.js` 守卫（**每个已声明类型必须出现在清单里**，漏一个就失败）
2. ✅ 契约版本纪律：`CONTRACT_VERSION` 升到 **1.2**；`src/contracts/contractSurface.js` 派生指纹，`test/contractVersion.test.js` 冻结它。改面不升版本会带着新指纹失败。测试里的版本字面量改为引用常量，下次 bump 不再改测试
3. ✅ **三处封闭清单已收拢**：
   - capability map → **模块加载即抛**（新增）
   - `KNOWN_ERROR_CODES` 白名单 → 反转为 `NEVER_EXPOSE_CODES` 黑名单（新增错误码默认透传，不再静默降级）
   - event→audit 的 `CASE` 白名单 → **整份删除**（每个分支都是恒等映射，改为直接读 `payload.command`）
   - `eventEnvelope.js` 的 `EVENT_TYPE_BY_EVIDENCE` 仍需人工同步，但已由 `test/activityTrace.test.js` 守住
4. ✅ Feishu 路由移入 `src/surfaces/feishu/httpAdapter.js`，脚本只负责组合和启动；`test/feishuHttpAdapter.test.js` 验证三个端点及故障响应

### P5 — 命名与可观测 ✅ 完成

1. ✅ `WORKER_KINDS` **不派生自 descriptor registry** —— 那会让 Core 依赖 ADR 003 刚分开的 Runtime 注册表，并让插件文件拓宽 Core 枚举。改为：补上缺失的 `claude`（桥让这个分歧变得致命：能读 Claude 会话却不能建 `workerKind=claude` 的 Run），并在两处定义点写明两者是**刻意不同**的分类，不变量由 `test/contractVersion.test.js` 钉住（Margin 自带的每个 agent type 都是合法 `workerKind`；`other` 是插件出口；列表保持封闭）
2. ✅ `test/activityTrace.test.js`：一次写入必须作为**带 actor 的完整 activity 条目**出现，且 `skippedUnknownEvents` 为 0，cursor 单调可用作增量读位。这条测试同时能抓住上面两处静默耦合

---

## 6. 不在本计划内

- 豆包 quota 读取器（需要那次 CDP 抓包；与架构梳理正交）
- PostgreSQL / pgvector 迁移
- Scheduler / lease、多 agent 组织、Temporal Council UI、移动端
- HTTP 认证、REST/GraphQL 正式化、SSE/WebSocket（ADR 002 已列为 Deferred）

---

## 附录 A — 端点清单（按 owner context 归类）

### A. Legacy REST（`src/app.js`，历史端点清单；启动入口已关闭）

`GET /api`、`GET /health`、`POST /chat`、`GET /state`、`GET|POST /actions`、`POST /actions/suggested`、`POST /actions/:id/status`、`GET /achievements`、`GET /achievements/recent`、`GET /achievements/icons`、`GET /learning`、`GET /learning/active`、`GET /learning/events`、`POST /learning/:id/steps/:stepIndex`、`GET /management/overview`、`GET|POST /management/proposals`、`POST /management/proposals/:id/confirm`、`POST /management/proposals/:id/cancel`、`GET /management/operation-events`、`GET /memory`、`GET /memory/states`、`GET /memory/profile`、`POST /memory/profile/refresh`、`POST /memory/profile/override`、`GET /memory/calibration`、`GET /memory/context`、`POST /memory/:id/pin`、`POST /memory/:id/priority`、`POST /summary`、`GET /summary/recent`、`POST /tts`

### B. Web Workbench Gateway（`src/http/createWebHttpAdapter.js`）

`GET /api/health`、`POST /api/commands`（types: `workstream.create|update|switch`、`run.create|start|pause|resume|stop`、`artifact.create`、`checkpoint.create`、`needs_owner.create|resolve`、`memory.confirm|correct|archive|restore`）、`POST /api/queries`（types: `workstream.list|get`、`run.get|list`、`artifact.list`、`decision.list`、`needs_owner.list`、`activity.list`、`checkpoint.latest`、`resume_brief.get`、`memory.list|search`）、`GET /api/events`、`POST /api/interactions`

### C. Margin Board（`src/core/handoff/httpAdapter.js`）

`GET /api/health`、`GET /api/resources/status`、`GET /api/agent-sources`、`POST /api/agent-sources/detect`、`POST /api/agent-sources`、`DELETE /api/agent-sources/:id`、`POST /api/agent-sources/:id/enable`、`POST /api/agents/install`、`POST /api/agents/uninstall`、`GET /api/sessions`、`GET /api/sessions/revision`、`GET /api/workspace-overview`、`POST /api/handoff/generate`、`POST /api/handoff/save`

### D. Feishu（`src/surfaces/feishu/httpAdapter.js`）

`POST /feishu/webhook`、`GET /health`、`POST /feishu/send-brief`

---

## 附录 B — 持久化对象归属

**Core（`marginCoreStore.js`，migration 1–6，checksum 校验）**
`margin_projects`、`margin_tasks`、`margin_decisions`、`margin_memories`、`margin_memory_embeddings`、`margin_events`、`margin_event_cursors`、`margin_audit_log`、`margin_actions`、`margin_runs`、`margin_artifacts`、`margin_checkpoints`、`margin_needs_owner`、`margin_schema_migrations`

**Legacy（`src/storage/memoryStore.js`，无版本化）**
`conversations`、`user_profile`、`user_states`、`learning_sessions`、`learning_events`、`actions`、`summaries`、`operation_proposals`、`operation_events`

**Margin 目录（`~/.margin/`）**
`agent-sources.json`（source registry，含 suppressed 墓碑）、`agents/*.json`（plugin descriptors）、`telemetry/usage.jsonl`、`telemetry/prices.json`、`margin.sqlite` / `terminal-pilot/margin-core.sqlite`

**外部 agent 侧（只读）**
`~/.codex/**`、`~/.claude/**`、`~/.pi/**`、豆包 `agent_mode/workspace/.sessions/**`
