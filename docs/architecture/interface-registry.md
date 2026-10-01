# Margin 接口清单（Interface Registry）

状态：与 `CONTRACT_VERSION` **1.2** 对齐
最后更新：2026-09-26
守卫：`test/interfaceRegistry.test.js` 会断言本文覆盖了**每一个**已声明的 Contract 类型。改动类型而不同步本文会让测试失败 —— 清单要么正确，要么不存在，不允许慢慢腐烂。

## 0. 两个 Context（ADR 003）

| Context | 拥有什么 | 访问方式 | 可写 |
|---|---|---|---|
| **Core** | Workstream / Run / Artifact / Checkpoint / Memory / Decision / Event / NeedsOwner | 只经 `MarginApplicationContract` 的 command / query / event | ✅ 是唯一可写路径 |
| **Runtime** | Agent Session / transcript / quota / agent source registry / handoff artifact | 各表面直接读外部 agent 的事实 | ❌ **只读**，不得写 Core 状态 |

两者唯一的连接是 **Session ↔ Run bridge**（`run.bind_session` / `session.resolve_runs`），落在 `Run.runtimeReference.canonicalSessionId`。

## 1. Contract 类型面（机器可读：`src/contracts/contractSurface.js`）

契约版本为 `1.2`。指纹由 `contractSurfaceFingerprint()` 计算，并由 `test/contractVersion.test.js` 与版本绑定。

### 1.1 Commands（`POST /api/commands`）

| Type | Capability | 说明 |
|---|---|---|
| `workstream.create` | `workstream:write` | |
| `workstream.update` | `workstream:write` | |
| `workstream.switch` | `run:control` | 暂停源 Run 并产出目标 brief，原子完成 |
| `run.create` | `run:control` | 一个 Workstream 同时只能有一个 open Run |
| `run.start` | `run:control` | 触发 runtime `activate` |
| `run.pause` | `run:control` | |
| `run.resume` | `run:control` | |
| `run.stop` | `run:control` | |
| `run.bind_session` | `run:control` | **Session ↔ Run bridge**；`sessionCanonicalId: null` 即解绑 |
| `checkpoint.create` | `checkpoint:write` | |
| `artifact.create` | `artifact:write` | 只存引用与 preview metadata，不传正文 |
| `needs_owner.create` | `needs_owner:write` | |
| `needs_owner.resolve` | `needs_owner:resolve` | |
| `memory.confirm` | `memory:confirm` | |
| `memory.correct` | `memory:correct` | |
| `memory.archive` | `memory:archive` | |
| `memory.restore` | `memory:restore` | |

所有 Command 必须带 `requestId`；可重试副作用还须带稳定 `idempotencyKey`（同键同输入重放原结果，同键不同输入返回 `idempotency_conflict`）。修改既有 aggregate 必须带 `expectedVersion`，陈旧版本返回 `version_conflict`。

### 1.2 Queries（`POST /api/queries`）

| Type | Capability | 说明 |
|---|---|---|
| `workstream.list` | `workstream:read` | |
| `workstream.get` | `workstream:read` | |
| `run.get` | `run:read` | |
| `run.list` | `run:read` | |
| `artifact.list` | `artifact:read` | |
| `decision.list` | `decision:read` | |
| `needs_owner.list` | `needs_owner:read` | |
| `activity.list` | `activity:read` | Event 的派生视图，**不新增 Activity 表** |
| `checkpoint.latest` | `checkpoint:read` | |
| `resume_brief.get` | `resume_brief:read` | |
| `memory.list` | `memory:read` | |
| `memory.search` | `memory:read` | |
| `session.resolve_runs` | `run:read` | **bridge 反向查询**，批量 1–100 个 canonical session id |

### 1.3 Events（`GET /api/events`）

`event.list`，capability `event:read`。Cursor 由 SQLite 持久、单调递增的 sequence 分配，**不从 timestamp 或 eventId 推导**。

已声明的 Event 类型（`EVENT_TYPES`）：

```
workstream.created  workstream.updated  run.created  run.started  run.progressed
run.paused  run.resumed  run.stopped  run.completed  run.failed  run.session_bound
checkpoint.created  artifact.created  decision.created  decision.superseded
decision.revoked  needs_owner.created  needs_owner.resolved  needs_owner.cancelled
memory.proposed  memory.confirmed  memory.superseded  memory.archived  memory.restored
```

## 2. HTTP 表面

四个表面、四套路由，**零交叉调用**。`/api/health` 四处响应形状已统一为 `{ ok, status, name, surface, contractVersion }`。

### 2.1 Surface C — Margin Board（当前默认，`npm start`）

Owner context：**Runtime**。端口 `MARGIN_SURFACE_PORT`（默认 3100），绑定 `127.0.0.1`。

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/health` | `surface: margin-board` |
| GET | `/api/sessions` | agent 会话列表；`runId`/`workstreamId` 来自注入的 bridge resolver，未注入或失败时为 `null` |
| GET | `/api/sessions/revision` | 廉价变更信号，不返回会话数据 |
| GET | `/api/workspace-overview` | |
| GET | `/api/resources/status` | 资源条；LKG/stale 由 `agentResourceService` 拥有 |
| GET | `/api/agent-sources` | source registry + 每项 `adapter` 布尔 + descriptor `problems` |
| POST | `/api/agent-sources/detect` | |
| POST | `/api/agent-sources` | 手动注册（可 `replaceId`） |
| DELETE | `/api/agent-sources/:id` | **任意 origin 可删**；探测会重建的写墓碑 |
| POST | `/api/agent-sources/:id/enable` | 撤销删除 |
| POST | `/api/agents/install` | 安装插件描述符（agent 自己负责下载） |
| POST | `/api/agents/uninstall` | 卸载描述符 + purge 该类型注册 |
| POST | `/api/handoff/generate` | 只有显式声明 handoff 能力的 adapter 才可用 |
| POST | `/api/handoff/save` | |

### 2.2 Surface B — Application Contract gateway（`npm run legacy:workbench`）

Owner context：**Core**。API-only（旧 UI 已按 ADR 003 删除）。端口 `PORT`（默认 3000）。

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/health` | `surface: workbench-gateway` |
| POST | `/api/commands` | §1.1 的全部类型 |
| POST | `/api/queries` | §1.2 的全部类型 |
| GET | `/api/events` | §1.3 |
| POST | `/api/interactions` | 与 Pi runtime 交互；无凭据时恒返回 `runtime_unavailable` |

### 2.3 Surface A — Legacy REST（`npm run legacy:api`，**已归档，不再启动**）

历史 owner context：无（直连 `src/services/*` → `src/storage/memoryStore.js`，独立 sqlite，无契约、无版本化）。原健康标识为 `legacy-rest`。以下端点仅供历史接口审计；启动入口现在返回 `legacy_api_archived`，不再监听。

端点（33）：`GET /api`、`GET /health`、`POST /chat`、`GET /state`、`GET|POST /actions`、`POST /actions/suggested`、`POST /actions/:id/status`、`GET /achievements`、`GET /achievements/recent`、`GET /achievements/icons`、`GET /learning`、`GET /learning/active`、`GET /learning/events`、`POST /learning/:id/steps/:stepIndex`、`GET /management/overview`、`GET|POST /management/proposals`、`POST /management/proposals/:id/confirm`、`POST /management/proposals/:id/cancel`、`GET /management/operation-events`、`GET /memory`、`GET /memory/states`、`GET /memory/profile`、`POST /memory/profile/refresh`、`POST /memory/profile/override`、`GET /memory/calibration`、`GET /memory/context`、`POST /memory/:id/pin`、`POST /memory/:id/priority`、`POST /summary`、`GET /summary/recent`、`POST /tts`

### 2.4 Surface D — Feishu（`npm run feishu`）

Owner context：**Core**（经 `createMarginCore`）。端口 `FEISHU_PORT`（默认 3200）。HTTP 路由由 `src/surfaces/feishu/httpAdapter.js` 统一注册，启动脚本负责组合与监听。

| Method | Path | 说明 |
|---|---|---|
| POST | `/feishu/webhook` | → Claude agent loop 或 Pi pilot |
| GET | `/health` | `surface: feishu`（含 `pilotReady`） |
| POST | `/feishu/send-brief` | 无 `FEISHU_OWNER_OPEN_ID` 时 400 |

## 3. CLI

| 命令 | 说明 |
|---|---|
| `margin` | 交互式 handoff 流程 |
| `margin agent list\|detect\|add\|remove\|enable\|install\|uninstall` | Agent Source 与插件生命周期 |
| `margin run bind\|unbind\|resolve` | Session ↔ Run bridge（作为持有 Core 的宿主，经 host-authority 路径） |
| `margin cost status\|report\|ingest` | 用量账本 |

## 4. ⚠️ 增加一个 Contract 类型时**必须同步的封闭清单**

这是 P2 实施时量化出来的。五处里有两处漏改是**静默**的：

| 处 | 漏改后果 |
|---|---|
| `src/contracts/contractTypes.js` | 类型不存在（响亮） |
| `src/contracts/validation.js` | `invalid_request`（响亮） |
| `src/application/marginApplicationContract.js`：capability map / handler | **模块加载即抛** `contract_capability_map_mismatch`（已加固） |
| `src/http/webCapabilities.js` | **模块加载即抛** `web_capability_map_mismatch` |
| `src/contracts/eventEnvelope.js` 的 `EVENT_TYPE_BY_EVIDENCE` | **静默**：事件无 envelope，直接从 activity 流消失 |

加固后仍需人工同步的只剩 `eventEnvelope.js` 的映射。`test/activityTrace.test.js` 断言新写入的操作必须出现在 activity 流里且携带 actor，因此漏映射会被测试抓住，而不是靠人记得。

另：错误信封**不含 message**（ADR 002 禁止泄漏内部文本），所以需要上下文的错误码必须走结构化 `details`（如 `version_conflict.currentVersion`、`session_already_bound.runId`）。错误码采用**黑名单**（`NEVER_EXPOSE_CODES`）而非白名单 —— 白名单会把漏加的错误码静默降级成 `storage_failure`。

## 5. 刻意的不对称（不是 bug）

| | |
|---|---|
| `WORKER_KINDS` 与 agent type 同名 | 前者是 **Core 的封闭词表**（校验 `run.workerKind`），后者是 **Runtime 的注册表**。不互相派生：Core 依赖 Runtime 注册表会破坏 ADR 003 的边界，且会让插件文件拓宽 Core 枚举。不变量：Margin 自带的每个 agent type 都是合法的 `workerKind`；`other` 是插件/未读运行时的出口。精确身份走 `runtimeReference.canonicalSessionId`。 |
| Claude 的 source 级 `capabilities.handoff = false`，但 session 级为 `true` | 历史行为，刻意保留：source 级是「该来源已验证支持什么」，session 级是「该会话可用哪些操作」。合并两者是一次静默的产品变更，不做。 |
| `/api/health` 在四个表面都存在 | 路径相同但端口不同；因此响应里必须带 `surface`，否则「打错端口」会看起来像成功。 |

## 6. 错误码

向外暴露的错误码（非 `storage_failure`）来自 `CoreContractError` / `ContractValidationError`，除 `NEVER_EXPOSE_CODES`（`sqlite_error` / `sqlite_constraint` / `internal_error`）外一律透传。

已使用：`invalid_request`、`permission_denied`、`capability_required`、`not_found`、`version_conflict`、`idempotency_conflict`、`invalid_transition`、`open_run_conflict`、`open_run_exists`、`runtime_unavailable`、`runtime_control_required`、`storage_failure`、`workstream_not_found`、`run_not_found`、`cross_workstream_reference`、`invalid_workstream_transition`、`session_already_bound`
