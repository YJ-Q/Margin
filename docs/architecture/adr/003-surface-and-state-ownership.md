# ADR 003：Surface 与 State 归属 — 两个有界 Context + 显式 bridge

状态：**已决策，P0/P1 部分已实施；P2（bridge）待实施**
日期：2026-09-26
前置：ADR 002（Transport-neutral Application Contract）、`docs/architecture/2026-09-26-architecture-inventory-and-consolidation-plan.md`

## Context

ADR 002 规定「任何 Surface 不得获取 repository、SQLite row、Pi Session 对象或 Runtime 私有事件」，所有 Surface 必须经 `MarginApplicationContract`。但勘察（4 路，见梳理文档）发现现状与这条规定不一致，且不只是接口层面的不一致：

1. **四条互不相交的调用图**：Legacy REST（`src/app.js` → `src/services/*` → `src/storage/memoryStore.js`）、Web Workbench Gateway（`src/http/*` → Application Contract → `margin-core.sqlite`）、Margin Board（`src/core/handoff/httpAdapter.js` → agent 会话文件）、Feishu（`scripts/run-feishu-surface.js`，脚本内手写路由 → `createMarginCore`）。四条图之间的调用次数为 0。
2. **两套持久化，域重叠，零同步**：legacy `memoryStore.js` 与 Core 各自拥有 memories / actions / decisions / projects，写进一个另一个看不见。
3. **当前默认表面明确拒绝 Contract**：`httpAdapter.js` 顶部注释写 "no SQLite core, no Application Contract, no Workstream/Run/Memory model"。这与 ADR 002 的立场同时为真，必须裁决。
4. **同一件现实事件被建模两次**：Core 的 `Run`（`margin_runs`，状态机、幂等、host 授权、审计）与 Board 的 **Agent Session**（读外部 agent 的会话文件）描述的是同一件事——「某个 agent 在为某件事跑一轮」——但两者无任何字段相连，系统无法回答「这个会话属于哪个工作流」。
5. **实现 ADR 002 的唯一结构化 UI 无法构建**：`web/vite.config.js` 只有 `margin.html` 一个入口，`web/index.html`（Workbench）永远不产出。

关键观察：ADR 002 的原句禁止 Surface 获取 **Pi Session 对象**。也就是说，**外部 agent 的会话本就不在 Contract 的域内**。这条为下面的方案 B 提供了直接依据。

## Decision

采用**两个有界 Context + 一个显式 bridge**，而不是把所有数据塞进一个 Contract。

### Context 1 — Core Context（Margin 拥有的持久状态）

Workstream / Run / Artifact / Checkpoint / Memory / Decision / Event / NeedsOwner。

- 唯一 owner：canonical Margin SQLite
- 唯一访问路径：`MarginApplicationContract` 的 command / query / event
- 任何 Surface 或 Worker 不得读取 repository、row 或内部事件

### Context 2 — Runtime Context（外部 agent 的既有事实）

Agent Session / transcript / quota / agent source registry / handoff artifact。

- **只读**。Margin 不拥有这些数据；写入它们的永远是外部 agent 本身
- 允许直接读文件系统与外部端点，因为把它们抬成 Contract DTO 会违反 ADR 002 对「Pi Session 对象」的禁止，并需要为外部文件系统伪造一个 repository
- 读取失败必须表达为 `unavailable` / `stale`，绝不允许伪装成「空的」

### 纪律（不可协商）

> **Runtime Context 只读。** 任何需要**写** Margin 拥有状态的路径必须经 Application Contract。Runtime adapter 不得直接写 SQLite，不得缓存可写状态。

这条纪律是 Context 2 存在的条件。一旦某个 runtime adapter 开始写 Margin 状态，它就变成了第二套业务实现，ADR 002 的意图即被绕过。

### Bridge — 一等对象，不做隐式耦合

`Run.runtimeReference` 已经存在（ADR 002 明确定义：「Margin aggregate ID 是主标识；Pi / Codex 等 ID 只出现在 `runtimeReference`」）。bridge 就落在这里，v1 版本 `1.1`。

新增两个 Contract 能力：

- `run.bindSession` — command，把 `canonicalSessionId` 绑定到某个 Run（走 `requestId` / `idempotencyKey` / `expectedVersion` 规则）
- `session.resolveRun` → `Run DTO | null` — query

于是「这个会话是哪个 Run / 属于哪个 Workstream」成为可查询事实，而不是靠 cwd 猜出来的分组。

### 一并裁决的两件事

1. **旧 Workbench UI 删除，契约层保留。**
   `web/index.html`、`web/src/{main.jsx,App.js,App.jsx,apiClient.js,useWorkbenchData.js,useEventPolling.js,workbenchState.js,styles.css,conflictState.js}` 与 `web/src/components/**` 删除，连同只覆盖它们的 11 个 UI 测试。
   依据：Contract 有 **20 个不经过 UI 的测试文件**在覆盖（`applicationContractCommands/Events/Queries/Validation`、`phase2aContractE2E`、`phase2aPersistence`、`runControl`、`memoryLifecycle`、`resumeBriefService`、`workstreamSwitchService`、`webGateway`、`webHttpAdapter`、`webInteractionHttp`、`webWorkbenchComposition`、`terminalPersistentRestart` 等）。删除的只是渲染层覆盖，契约行为不受影响。
   `createWebWorkbench` 相应改为 API-only：不再要求预构建前端，有资产时仍然挂载。

2. **`WORKER_KINDS` 统一到 agent type。**
   `src/contracts/contractTypes.js` 的 `WORKER_KINDS = ['pi','codex','other']` 与 descriptor 的 agent type（`codex`/`claude`/`pi` + plugin）同名不同义，是必然被误解的陷阱。改为从 descriptor registry 派生（与 `AGENT_TYPES` 已有的处理方式一致），不再单独维护一份清单。

## Alternatives

- **方案 A：单 Core，把 Board 的 sessions/resources/agent-sources/handoff 全部并入 Application Contract。**
  拒绝。字面符合 ADR 002，但要为外部 agent 的文件系统造一个 file-backed repository（`repository` 的语义是「我拥有的状态」），同时与 ADR 002「不得获取 Pi Session 对象」直接冲突。代价是一次 Contract 大版本，收益只是形式上的一致。
- **保持现状，承认两个系统。**
  拒绝。现状不是「两个系统」，而是「四条图 + 两套库 + 零同步 + 一条与 ADR 002 矛盾的孤立立场」。它没有可判定的边界，因而不可能被测试或审计。
- **把 Runtime Context 也做成可写。**
  拒绝。那就是第二套业务实现，ADO 002 的核心意图（Margin 拥有的状态只有一个 owner）随即失效。

## Consequences

优点：

- Margin 拥有的状态仍然只有一个 owner，ADR 002 的意图完整保留
- 外部 agent 数据不再被强行纳入契约域，读取失败可以用 `unavailable`/`stale` 诚实表达（这一步已经落地，见 `resourceStatusOf`）
- bridge 是可增量、可单独验收的：先只读、先 CLI、后 UI
- 「这个会话属于哪个工作流」从猜测变成事实

成本：

- 需要维护**两个**概念的命名纪律（Core 的 `Run` vs Runtime 的 `Session`），并在文档与代码注释里反复说明边界
- Bridge 是新的持久化字段（`Run.runtimeReference.sessionCanonicalId`），需要一次 additive migration
- `WORKER_KINDS` 派生化会触及 `contractTypes.js` 的既有消费者

## Deferred

- 两套持久化的合并（legacy `memoryStore.js` 的导出 → 分类 → 归档），须按 `v1_minimum_incremental_architecture.md` 既有要求执行，且不删 `data/echo.sqlite`
- Contract 版本纪律（`COMMAND_TYPES`/DTO 形状变化必须递增 `CONTRACT_VERSION`，并用测试守住）
- Feishu 表面从脚本内手写 if/else 改为 router + 契约校验
- HTTP 认证、SSE/WebSocket、Scheduler lease（ADR 002 已列为 Deferred，不变）

## Implementation evidence

**已完成（2026-09-26，本 ADR 同一变更内）**

- `/api/health` 在四个表面统一为 `src/surfaceHealth.js` 的单一形状，含 `surface` 与 `contractVersion`
- 旧 Workbench UI 与其 11 个 UI 测试删除；`createWebWorkbench` 改为 API-only；`run-web-workbench.js` 与 `run-legacy-api.js` 的输出文案改为符合实际
- `docker-compose.yml` 移除属于其他表面的 `PORT`，并注明容器内 `0.0.0.0` 的必要性
- 未跟踪资产入库（`src/surfaces/feishu/**`、`src/agents/descriptor/**`、`src/agents/agentInstall.js`、`plugins/**`、`experiments/**`、新增测试与文档）

**待实施（P2，本 ADR 的实质部分）**

- `run.bindSession` / `session.resolveRun` 两个 Contract 能力
- `Run.runtimeReference.sessionCanonicalId` 的 additive migration
- Board session DTO 增加 `runId` / `workstreamId`（缺省 `null`）
- `margin run bind <runId> <sessionCanonicalId>` CLI

**验收标准（P2）**：一次真实重启后，Board 上某个 Codex 会话能显示它所属的 Workstream，且能从 Workbench（或 CLI query）反查到它对应的会话。
