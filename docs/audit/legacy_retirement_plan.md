# Legacy Retirement Plan（P3）

状态：**数据与功能已本地归档；旧 API 启动入口已关闭**
日期：2026-09-26
前置：`docs/audit/legacy_data_disposition.md`（Phase 1 的边界与策略）、`docs/architecture/2026-09-26-architecture-inventory-and-consolidation-plan.md` §P3

## 1. 边界（不变）

`data/terminal-pilot/margin-core.sqlite` 是 Margin V1 唯一 Source of Truth。`data/echo.sqlite` 是**冻结的 legacy 数据集**。`src/app.js`、`src/routes/`、`src/services/`、`src/storage/memoryStore.js` 作为历史源码留在 Git 中；`src/server.js` 和 `npm run legacy:api` 现均只返回归档状态，不再打开可写的旧 API。

## 2. 只读清单复核（2026-09-26）

```powershell
npm run inventory:legacy
```

| 证据 | 值 |
|---|---|
| 数据库文件哈希 | `1f565309275899fe9bc366086e8bbb8a148fd368b4e7a6d575c6d0028778a9f1` |
| Schema 哈希 | `4c4fc799f1f3d58177a7506c56920e7693c2d5e6f541821bbc1de3830619fdbd` |
| policy | `read_only_inventory_no_automatic_import` |

| 表 | 行数 | 处置 |
|---|---:|---|
| conversations | 19 | archive |
| summaries | 1 | archive |
| actions | 2 | archive |
| learning_sessions | 1 | archive |
| learning_events | 12 | archive |
| user_profile | 8 | archive |
| knowledge_base | 0 | archive |
| operation_proposals | 3 | archive |
| operation_events | 5 | archive |
| user_states | 6 | archive |

**结论：与 Phase 1（2026-08-23）逐表行数完全一致，数据集未被改动。** 本轮新增了文件与 schema 哈希，使「未改动」从断言变成可复核的证据。

## 3. 数据侧：全部仅归档（2026-09-26 用户决定）

用户决定 10 张表全部仅归档：不迁入新版 Core，也不删除原库。归档文件保存在本地被 Git 忽略的 `data/exports/echo-legacy-2026-09-26.json`。它包含原始记录正文，不能提交到仓库。

- [x] 导出工具存在且拒绝覆盖（`export:legacy`，需 `--approve` + 新路径）
- [x] 只读清单与哈希可复核
- [x] **逐表用户决定**：10 张表均归档，不迁移、不删除
- [x] 导出完成，JSON 内 10 张表的行数与上表逐项相符；导出文件 SHA-256：`49716bb9ac71d3ea4907ec3df03287b0b5ffa9697da26209964b1eeb2b697702`

`data/echo.sqlite` 是保留的原始归档，不删除（已由 `test/legacyRetirement.test.js` 断言）。

## 4. 端点侧：真正的发现 —— 5 个功能只存在于废弃表面上

33 个 legacy 端点的去留不是 33 个独立决定，而是**功能级**决定。核查后，其中若干功能在**当前任何表面（Board / Contract gateway / Feishu）上都没有对应实现**：

| 功能 | 端点数 | 当前表面是否有等价能力 | 退役后 |
|---|---|---|---|
| Memory 读写（legacy 库） | 9 | Contract 有 `memory.*`，但**是另一个库**，语义不同 | 决定：是否迁移数据 |
| Actions | 4 | 有 `action_update` 工具写 Core | 可退役 |
| Management proposals（operation_proposals / events） | 6 | **无** | ⚠️ 功能随表面消失 |
| Achievements | 3 | **无** | ⚠️ 功能随表面消失 |
| Learning sessions / events | 4 | **无** | ⚠️ 功能随表面消失 |
| Summaries（daily summary / reflection） | 2 | **无**（`resume_brief` 是不同东西） | ⚠️ 功能随表面消失 |
| TTS | 1 | **无** | ⚠️ 功能随表面消失（且 `SILICONFLOW_API_KEY` 未配置时恒 502） |
| Chat | 1 | Contract 的 `/api/interactions` 是 Pi runtime，不是同一路径 | 决定：是否重接 |
| State / health / discovery | 3 | Contract gateway | 可退役 |

**用户决定**：Management proposals、Achievements、Learning、Summaries、TTS 全部归档，不移植。旧 API 启动入口已关闭；历史实现与测试保留在 Git 中，便于审计与恢复。

建议的处置顺序：

1. 五项功能均按归档处理，不在新表面实现
2. 若将来需要物理移除历史实现，先将遗留备份/导入脚本和其测试一并梳理，再做独立清理；当前入口不依赖这些模块

## 5. 代码侧：已完成的部分

### 5.1 冻结是可执行的，不只写在文档里

`test/legacyRetirement.test.js` 断言三件事：

1. **当前入口不可达 legacy**：对 `scripts/run-margin-surface.js`、`scripts/run-web-workbench.js`、`electron/main.js`、`bin/margin.js` 做**静态 import 图遍历**，断言可达集合里不含 `src/app.js`、`src/storage/memoryStore.js`、`src/config/env.js`、`src/routes/**`、`src/services/**`。
   → 没有这条，一次重构就能把 `src/services/*` 悄悄重新引进默认表面，而冻结只存在于文档里。
2. **旧入口不可启动**：`src/server.js` 无监听器，即使传入旧 `MARGIN_ENABLE_LEGACY_API=true` 也返回 `legacy_api_archived`；`scripts/run-legacy-api.js` 不再设置该变量。
3. **数据集保留**：`data/echo.sqlite` 必须存在，且本文必须覆盖全部 10 张表（漏一张表就失败，防止在决定时遗漏）。

### 5.2 已确认的边界事实

- `scripts/run-legacy-api.js` 和 `run-echo-local.cmd` 现在均报告归档状态，不再启动旧服务
- `docker-compose` 不再设置属于 legacy 表面的 `PORT`
- 默认入口与 legacy 之间**没有**共享的可写状态：两套 SQLite，零同步（见梳理文档 §1.2）

## 6. 导出流程（已执行）

```powershell
npm run inventory:legacy
npm run export:legacy -- data/echo.sqlite --approve --output data/exports/echo-legacy-2026-09-26.json
```

导出需要 `--approve` 与新路径，覆盖会被拒绝。导出物包含记录正文，因此 `data/exports/` 已在 `.gitignore` 中。
