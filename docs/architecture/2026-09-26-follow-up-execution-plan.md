# Margin 后续执行计划与验收

日期：2026-09-26
范围：接续架构收敛计划，完成仍有证据缺口的环节，并落实 legacy 全部归档的用户决定。

## 1. 验证证据完整性

- [x] 区分已入库的清洗后 handoff/manifest 与本地忽略的原始会话 `.jsonl`。
- [x] 核对所有已发布 manifest 指向的文件；修复 12 个基线哈希与 42 个后续文件的字节数/压缩比例。
- [x] 加入 `scripts/verify-validation-manifests.js` 和自动测试，持续核对 54 个文件；隐私守卫禁止原始 `.jsonl` 被跟踪。

验收：验证脚本返回 `checked: 54`、`mismatches: []`；隐私测试通过。原始会话不改写、不提交。

## 2. Legacy 归档闭环

- [x] 10 张表全部仅归档；保留原始 SQLite 与本地完整 JSON 导出，不迁移、不删除。
- [x] 关闭 `src/server.js` 与 `npm run legacy:api` 的监听路径，包括旧 opt-in 变量存在时；保留历史源码与测试以供审计。
- [x] 更新启动脚本、README、审计文档及入口守卫。

验收：`npm run legacy:api` 返回 `legacy_api_archived` 且退出码为 1；原始数据库 SHA-256 保持 `1f565309275899fe9bc366086e8bbb8a148fd368b4e7a6d575c6d0028778a9f1`。

## 3. Feishu 接口收敛

- [x] 将三个路由移入 `src/surfaces/feishu/httpAdapter.js`；启动脚本只负责组合与监听。
- [x] 保留健康检查的统一响应，补齐 webhook 失败时的 JSON 错误响应。
- [x] 用隔离的 HTTP 测试覆盖三个端点、未知路由与故障路径。

验收：隔离测试通过；实际 Feishu 健康检查返回 HTTP 200、`surface: feishu`、契约版本 1.2。

## 4. 总体验收

- [x] 全量 718 项测试、前端构建、验证脚本和三个活跃入口的健康检查均通过。
- [x] 工作树差异检查无格式错误；私有归档与原始会话保持 Git 忽略。

历史 legacy 模块的物理删除留作单独清理：其测试、备份/导入脚本仍使用这些模块，移除前需要逐一处理依赖。归档决策已通过关闭运行入口落实，无需为了删除源码改写历史测试。

## 2026-09-27 续阶段：移除冻结的旧实现 ✅ 完成（2026-10-01）

- [x] 核对当前运行入口无旧实现依赖；保留 `inventory:legacy`、`export:legacy` 和本地归档原件。
- [x] 移除已归档的 `src/app.js`、`src/routes/`、`src/services/`、`src/storage/memoryStore.js` 及其专属配置、旧备份/导入/管理脚本；保留返回归档状态的兼容启动提示。
- [x] 移除仅验证已归档产品的测试；改造混合测试，保留 Core、入口边界与归档数据的有效验证。
- [x] 验证完整导出仍可在新文件中重建、拒绝覆盖，且原始数据库哈希不变。
- [x] 全量测试、构建、入口健康检查和隐私守卫通过。

验收结果（2026-10-01）：`npm test` 592/592 通过；`npm run build` 成功；`npm run validate:stage1` 10/10；`npm run audit:pi` 通过；Board/Workbench/Feishu 健康检查均 HTTP 200、contractVersion 1.2；Legacy API 返回 `legacy_api_archived`（exit 1）；数据库哈希 `1f565309` 未变。Commit `bde4879`。

这一步删除的是当前工作树中的旧代码；已跟踪的历史版本仍可从 Git 恢复。原始 SQLite、JSON 归档和只读清单/导出工具不删除。
