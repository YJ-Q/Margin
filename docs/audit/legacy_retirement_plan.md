# Legacy Retirement Plan（P3）

状态：**代码侧已完成（冻结 + 可执行守卫）；数据侧等待逐表决定**
日期：2026-09-26
前置：`docs/audit/legacy_data_disposition.md`（Phase 1 的边界与策略）、`docs/architecture/2026-09-26-architecture-inventory-and-consolidation-plan.md` §P3

## 1. 边界（不变）

`data/terminal-pilot/margin-core.sqlite` 是 Margin V1 唯一 Source of Truth。`data/echo.sqlite` 是**冻结的 legacy 数据集**。`src/routes/`、`src/services/`、`src/storage/memoryStore.js` 保持冻结，只由一个显式命名的入口可达。

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
| actions | 2 | migrate candidate after review |
| learning_sessions | 1 | migrate candidate after review |
| learning_events | 12 | migrate candidate after review |
| user_profile | 8 | migrate candidate after review |
| knowledge_base | 0 | delete candidate after export |
| operation_proposals | 3 | delete candidate after export |
| operation_events | 5 | delete candidate after export |
| user_states | 6 | delete candidate after export |

**结论：与 Phase 1（2026-08-23）逐表行数完全一致，数据集未被改动。** 本轮新增了文件与 schema 哈希，使「未改动」从断言变成可复核的证据。

## 3. 数据侧：等你的逐表决定

removal gate 要求三项，前两项已完成、第三项未完成：

- [x] 导出工具存在且拒绝覆盖（`export:legacy`，需 `--approve` + 新路径）
- [x] 只读清单与哈希可复核
- [ ] **逐表用户决定**：4 个 `migrate candidate`（actions / learning_sessions / learning_events / user_profile）需要你逐表确认是否迁移到 Core；3 个 `delete candidate` 需要显式删除批准

在第三项完成前，**`data/echo.sqlite` 不得删除**（已由 `test/legacyRetirement.test.js` 断言）。

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

**这意味着「退役 legacy」不是删除死代码，而是删掉 5 个功能**（Management proposals、Achievements、Learning、Summaries、TTS）。在逐项确认之前，这个阶段不应执行删除。

建议的处置顺序：

1. 对 5 个功能逐个给出「移植 / 归档 / 删除」结论（这一步需要你决定，我不替你判断产品意图）
2. 移植项在新表面上实现后，才删除对应 legacy 端点
3. 全部有结论后一次性删除 `src/app.js` + `src/routes/**` + `src/services/**`，并同步删除只覆盖它们的测试（当前是 `test/api.test.js` 与零散的 legacy 测试）

## 5. 代码侧：已完成的部分

### 5.1 冻结是可执行的，不只写在文档里

`test/legacyRetirement.test.js` 断言三件事：

1. **当前入口不可达 legacy**：对 `scripts/run-margin-surface.js`、`scripts/run-web-workbench.js`、`electron/main.js`、`bin/margin.js` 做**静态 import 图遍历**，断言可达集合里不含 `src/app.js`、`src/storage/memoryStore.js`、`src/config/env.js`、`src/routes/**`、`src/services/**`。
   → 没有这条，一次重构就能把 `src/services/*` 悄悄重新引进默认表面，而冻结只存在于文档里。
2. **门控仍然紧闭**：`src/server.js` 必须要求 `MARGIN_ENABLE_LEGACY_API === 'true'`（精确匹配、拒绝而非警告）；只有 `scripts/run-legacy-api.js` 可以打开它；默认表面不得触碰这个变量。
3. **数据集保留**：`data/echo.sqlite` 必须存在，且本文必须覆盖全部 10 张表（漏一张表就失败，防止在决定时遗漏）。

### 5.2 已确认的边界事实

- `scripts/run-legacy-api.js` 的弃用文案本轮已改对（原文案让用户去看 Web Workbench，而该 UI 已按 ADR 003 删除）
- `docker-compose` 不再设置属于 legacy 表面的 `PORT`
- 默认入口与 legacy 之间**没有**共享的可写状态：两套 SQLite，零同步（见梳理文档 §1.2）

## 6. 导出流程（未执行）

```powershell
npm run inventory:legacy
npm run export:legacy -- data/echo.sqlite --approve --output data/exports/echo-legacy-v1.json
```

导出需要 `--approve` 与新路径，覆盖会被拒绝。导出物包含记录正文，因此 `data/exports/` 已在 `.gitignore` 中。
