<!-- benchmark-case: case-04 | session-id: 01a07639-d0ef-7452-a987-af0de51b29e3 | workspace-repo: <repo> -->
# Margin Smart Handoff

源 checkpoint：2026-09-07T04:47:57.131Z；Repo Truth：2026-09-07T04:47:57.380Z。
Confirmed = 句子描述的事实。Inferred = 解释/意图。Uncertain = 未能确认，不代表失败。

## 目标（历史请求，接手前请确认是否更新）

- **Inferred** 对当前 Margin repo 做只读 cleanup audit，不修改文件。以 CLI V1 + `src/core/handoff` + Electron V2 + 当前 Margin React Surface 为当前产品主线。扫描 imports、exports、package scripts、tests、runtime entry，按 KEEP / RETIRE / GENERATED / DEFER 分类。重点检查旧 Workstream/Run/Memory/Pilot/Application/Workbench 路径，判断哪些已完全脱离当前产品主链。列出每个可删除目录/文件的引用证据、受影响 tests/scripts、删除风险，并给出一个最小 cleanup plan。不要因为“看起来旧”就建议删除；只有确认没有当前主链依赖才标记 DELETE CANDIDATE。不要实际删除文件。


## 当前状态

- **Confirmed** 当前仓库 <repo>；branch=main；HEAD=a247e75ab9e78cce7853e3f281b85459a4f25e7c；112 个已跟踪修改/未跟踪文件。

## Progress

- **Confirmed · Historical** Historical validation: 1 focused test command exited 0.

- **Uncertain · Historical** Historical validation: 1 focused test command had no explicit final result.

- **Uncertain · Current** Current validation: unknown; historical tests have not been rerun against the current repository observation.

## Historical Report

- **Inferred · Historical** 审计完成，未修改任何文件。当前产品主链是：

## 已完成（事实范围）

- **Confirmed** 历史命令进程已成功返回：& .\.runtime\node-v22.23.1-win-x64\node.exe --test test/handoff.test.js test/marginCli.test.js test/marginSurfaceHttpAdapter.test.js test/marginRecentSessionsList.test.js test/m...（exit_code=0）；不代表之后文件仍未变化。

## 失败 / 已拒绝

- **Confirmed** 命令进程失败：Get-Content src/core/marginCoreStore.js | Select-Object -First 100; Write-Output '--- handoff current closure: imports in its tree ---'; rg -n "^(import|export).*from|import\(" ...；exit_code=1

- **Confirmed** 命令进程失败：Get-ChildItem web/src/components -Filter *.jsx | ForEach-Object { "--- $($_.Name)"; Get-Content $_.FullName }; Write-Output '--- references to component JSX paths ---'; rg -n "c...；exit_code=1

## Open Issues

- **Uncertain** 13 个内部操作在捕获证据中没有明确终态（含空补丁返回、裁剪）；这不是当前阻塞清单。已存在文件只能证明当前存在，不能倒推历史命令成功。

## 测试

- **Confirmed** 测试命令 & .\.runtime\node-v22.23.1-win-x64\node.exe --test test/handoff.test.js test/marginCli.test.js test/marginSurfaceHttpAdapter.test.js test/marginRecentSessionsList.test.js test/m...：succeeded；exit_code=0。

- **Uncertain** 测试命令 & .\.runtime\node-v22.23.1-win-x64\node.exe --test test/handoff.test.js test/marginCli.test.js test/marginSurfaceHttpAdapter.test.js test/marginRecentSessionsList.test.js test/m...：unknown；No explicit success/failure in result。

## 接手建议（非当前动作结论）

- **Inferred** 先阅读已存在产物与当前相关文件，核对未返回调用及报告时间；仅执行确实缺失的下一步。复用经核对仍有效的文件与依赖，不直接重建或重装；不因旧 Session 的空待办数组就宣布任务完成。

## Evidence Pointers

- 快照：<repo>\docs\validation\recovery-handoffs-postfix\session-01a07639-d0ef-7452-a987-af0de51b29e3.jsonl
- SHA-256：a79da02da100ee86ca5d7c5b2e4834865f8f6bda6b881d225354a112b36be408
- Workspace：<repo>
- call:L<n>/op<m> 指向 evidence 的 operations；file:* / repo:git 指向 repo-truth。
- 接手时读证据而非直接执行历史代码片段。
