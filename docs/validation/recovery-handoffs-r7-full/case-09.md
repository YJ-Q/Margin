<!-- benchmark-case: case-09 | session-id: 01a070e6-3bd9-7591-aa4e-31b364badda1 | workspace-repo: <repo> -->
# Margin Smart Handoff

源 checkpoint：2026-09-07T09:27:28.711Z；Repo Truth：2026-09-07T09:27:29.051Z。
Confirmed = 句子描述的事实。Inferred = 解释/意图。Uncertain = 未能确认，不代表失败。

## 目标（历史请求，接手前请确认是否更新）

- **Inferred** Phase 0 已完成。

当前已确认：

- "continues 4.1.1" 可以承担 Session Discovery 和基础解析；
- 当前真实样本包含 191 条原始记录、7 条标准化对话、25 次工具调用、24 次工具返回；
- 当前主要信息损失发生在 "exec" 等封装内部：修改行为及调用结果的语义没有被可靠恢复；
- 单纯提高 "continues" 的 verbosity / sample 上限无法解决；
- 当前最重要的产品假设仍然是：能否从原始调用—结果证据中恢复足够准确的开发状态，让新的 Agent 不重复工作。

本阶段执行：

Phase 1：Margin Distiller PoC

一、唯一核心目标

验证：

«Margin 是否能够根据 Session + Tool Call / Result + Git / Workspace 事实，在明显少于完整 Session 的上下文中，准确恢复足够让下一个 Agent 继续开发的状态。»

不要把“压到固定 1K–3K Token”作为唯一目标。

优先级是：

1. Continuation Quality
2. 信息真实性
3. Token 效率

---

二、输入

优先复用 Phase 0 产物：

- "experiments/phase0-continues/output/baseline-context.json"
- "baseline-continues-handoff.md"
- "baseline-session-info.md"
- 原始 Codex Session
- 当前 Workspace / Git 状态

必要时读取原始 Session，但不要重复开发已有 Session Discovery / Parser。

---

三、先建立 Evidence Layer

不要直接从 Conversation 生成摘要。

先从原始信息建立可追溯 Evidence。

至少识别：

- User requirement
- Assistant claim
- Tool call
- Tool result
- File edit/write
- Shell command
- Test execution
- Test result
- Git state
- Workspace state

重点建立：

"Tool Call → Tool Result"

之间的关联。

尤其处理：

- "exec"
- shell
- patch / edit / write
- test command

不能只因为 Assistant 声称“已经完成”，就把任务标记为 Completed。

---

四、事实可信度

Distilled State 中的信息至少区分三种状态：

Confirmed

有直接事实依据，例如：

- Git
- 文件实际状态
- Tool result
- 测试结果
- 成功执行的 edit / write

Inferred

主要来自 Session 语义，例如：

- 当前真实目标
- 技术决策原因
- 下一步意图

Uncertain

出现以下情况：

- Assistant 自述和 Tool / Git 证据冲突；
- 无法确认操作是否成功；
- Session 数据缺失；
- 信息只有弱证据。

不要为了生成完整 Handoff 而填补不存在的信息。

---

五、生成前刷新 Repo Truth

Handoff 生成时，不应只相信历史 Session。

如果 Workspace 仍存在，应重新获取：

- 当前 branch
- HEAD

- **Inferred** 完成剩余的工作


## 当前状态

- **Confirmed** 当前仓库 <repo>；branch=main；HEAD=a247e75ab9e78cce7853e3f281b85459a4f25e7c；346 个已跟踪修改/未跟踪文件。

## Progress

- **Inferred · Historical** Assistant-reported milestone: Phase 1 Distiller PoC 已完成。

- **Confirmed · Historical** Historical validation: 10 focused test commands exited 0.

- **Uncertain · Historical** Structured work evidence: 17 edit operations had no explicit historical result.

- **Confirmed · Current** Current repo corroboration: 13/13 structured historical targets currently exist.

- **Uncertain · Current** Current validation: unknown; historical tests have not been rerun against the current repository observation.

## Historical Report

- **Inferred · Historical** Phase 1 Distiller PoC 已完成。

- **Inferred · Historical** Terminal assistant report (excerpt): Phase 1 Distiller PoC 已完成。 实现位于独立目录 [`experiments/phase1-distiller`](<repo>/experiments/phase1-distiller)，没有修改正式 Margin Core、UI、Runtime 或 `continues` 上游代码。 已完成： - 建立 Evidence Layer，识别并关联： - User requirement - Assistant claim - Tool call / result - Shell command - File edit/write - Test execution / result - Git / Workspace state - 支持 `exec` 内部静态解析，不执行历史代码。 - 处理 `Promise.all 已完成： - 建立 Evidence Layer，识别并关联： - User requirement - Assistant claim - Tool call / result 测试： ```text 15 tests passed 0 failed ``` 运行的是 Phase 1 直接相关测试： [`distiller.test.mjs`](<repo>/experiments/phase1-distiller/distiller.test.mjs) 没有运行全仓测试、UI 构建或 Release 级验收。 当前结论：Phase 1 已证明可以从原始调用—结果证据和当前仓库事实中恢复比 `continues standard` 更可靠的开发状态；但真实新 Agent 的行为级 Continuation Quality 尚未验证。下一步唯一应验证的是：使用一个独立的“失败—修复—测试”开发 Session，对比 standard 与 Margin Handoff 是否减少重复修改、错误测试判断和遗漏下一步。 Git 仍为 `main`，HEAD 为

## 已完成（事实范围）

- **Confirmed** 历史命令进程已成功返回：git clone --depth 1 https://github.com/yigitkonur/cli-continues.git .runtime/phase0-continues/upstream（exit_code=0）；不代表之后文件仍未变化。（同一事实重复出现 2 次，仅展示一次）

- **Confirmed** 历史命令进程已成功返回：npm.cmd install --ignore-scripts --no-audit --no-fund（exit_code=0）；不代表之后文件仍未变化。（同一事实重复出现 2 次，仅展示一次）

- **Confirmed** 历史命令进程已成功返回：.\.runtime\node-v22.23.1-win-x64\node.exe --test experiments/phase1-distiller/distiller.test.mjs（exit_code=0）；不代表之后文件仍未变化。（同一事实重复出现 8 次，仅展示一次）

- **Confirmed** 历史命令进程已成功返回：.\.runtime\node-v22.23.1-win-x64\node.exe --test experiments/phase1-distiller/distiller.test.mjs | Tee-Object -FilePath experiments/phase1-distiller/output/targeted-tests.tap; e...（exit_code=0）；不代表之后文件仍未变化。（同一事实重复出现 2 次，仅展示一次）

- **Confirmed** 历史命令进程已成功返回：npm.cmd install --ignore-scripts --no-audit --no-fund（PTY completion via call:L87/op2: exit_code=0）；不代表之后文件仍未变化。

- **Confirmed** 历史命令进程已成功返回：npm.cmd install --ignore-scripts --no-audit --no-fund（PTY completion via call:L333/op1: exit_code=0）；不代表之后文件仍未变化。

- **Confirmed** 文件当前已存在：experiments\phase0-continues\package.json；与新增内容一致。先检查现状，避免直接重复创建。

- **Confirmed** 文件当前已存在：experiments\phase0-continues\.gitignore；与新增内容一致。先检查现状，避免直接重复创建。

- **Confirmed** 文件当前已存在：experiments\phase0-continues\run-baseline.mjs；最近补丁添加行仍存在，未证明完整历史应用结果。先检查现状，避免直接重复创建。

- **Confirmed** 文件当前已存在：experiments\phase0-continues\verify-baseline.mjs；与新增内容一致。先检查现状，避免直接重复创建。

- **Confirmed** 文件当前已存在：experiments\phase0-continues\README.md；最近补丁添加行仍存在，未证明完整历史应用结果。先检查现状，避免直接重复创建。

- **Confirmed** 文件当前已存在：experiments\phase1-distiller\package.json；与新增内容一致。先检查现状，避免直接重复创建。

- **Confirmed** 文件当前已存在：experiments\phase1-distiller\.gitignore；与新增内容一致。先检查现状，避免直接重复创建。

- **Confirmed** 文件当前已存在：experiments\phase1-distiller\evidence.mjs；最近补丁添加行仍存在，未证明完整历史应用结果。先检查现状，避免直接重复创建。

- **Confirmed** 文件当前已存在：experiments\phase1-distiller\distiller.mjs；最近补丁添加行仍存在，未证明完整历史应用结果。先检查现状，避免直接重复创建。

- **Confirmed** 文件当前已存在：experiments\phase1-distiller\run-distiller.mjs；最近补丁添加行仍存在，未证明完整历史应用结果。先检查现状，避免直接重复创建。

- **Confirmed** 文件当前已存在：experiments\phase1-distiller\distiller.test.mjs；最近补丁添加行仍存在，未证明完整历史应用结果。先检查现状，避免直接重复创建。

- **Confirmed** 文件当前已存在：experiments\phase1-distiller\evaluation.md；与新增内容一致。先检查现状，避免直接重复创建。

- **Confirmed** 文件当前已存在：experiments\phase1-distiller\README.md；与新增内容一致。先检查现状，避免直接重复创建。

## 失败 / 已拒绝

- **Confirmed** 命令进程失败：Get-Content -Raw Margin_Phase0_PoC_Plan.md; Get-Content -Raw package.json; Get-Content -Raw README.md; Get-Content -Raw .gitignore; rg --files .agents docs src scripts evaluatio...；exit_code=1

- **Confirmed** 命令进程失败：New-Item -ItemType Directory -Force experiments/phase0-continues | Out-Null; $snapshotFiles = @(git diff --name-only) + @(git ls-files --others --exclude-standard); $snapshot = ...；fatal: unable to access 'https://github.com/yigitkonur/cli-continues.git/': schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)（同一事实重复出现 2 次，仅展示一次）

- **Confirmed** 命令进程失败：Get-Content -TotalCount 100 docs/architecture/phase_1_persistent_core.md; Get-Content -TotalCount 75 src/application/continuityService.js; rg --files --hidden -g AGENTS.md -g '!...；npm error code EPERM

- **Confirmed** 命令进程失败：node --input-type=module -e 'import fs from "node:fs"; import os from "node:os"; import {adapters} from "continues"; console.log({home:os.homedir(),codexHome:process.env.CODEX_H...；Error: EPERM: operation not permitted, open '<repo>\experiments\phase0-continues\output\discovery-initial.json'（同一事实重复出现 2 次，仅展示一次）

- **Confirmed** 命令进程失败：Get-ChildItem -LiteralPath 'C:\Users\<user>\.codex\sessions' -Recurse -Filter '*.jsonl' | Select-Object FullName,Length; Get-ChildItem -LiteralPath 'C:\Users\<user>\.codex' -Directory...；| Access to the path 'C:\Users\<user>' is denied.（同一事实重复出现 2 次，仅展示一次）

## Open Issues

- **Uncertain** 28 个内部操作在捕获证据中没有明确终态（含空补丁返回、裁剪）；这不是当前阻塞清单。已存在文件只能证明当前存在，不能倒推历史命令成功。

## 测试

- **Confirmed** 测试命令 .\.runtime\node-v22.23.1-win-x64\node.exe --test experiments/phase1-distiller/distiller.test.mjs：succeeded；exit_code=0。

- **Confirmed** 测试命令 .\.runtime\node-v22.23.1-win-x64\node.exe --test experiments/phase1-distiller/distiller.test.mjs | Tee-Object -FilePath experiments/phase1-distiller/output/targeted-tests.tap; e...：succeeded；exit_code=0。

- **Confirmed** 测试命令 .\.runtime\node-v22.23.1-win-x64\node.exe --test experiments/phase1-distiller/distiller.test.mjs：succeeded；exit_code=0。

- **Confirmed** 测试命令 .\.runtime\node-v22.23.1-win-x64\node.exe --test experiments/phase1-distiller/distiller.test.mjs | Tee-Object -FilePath experiments/phase1-distiller/output/targeted-tests.tap; e...：succeeded；exit_code=0。

## 改动文件

- **Confirmed** `experiments\phase0-continues\package.json`：当前 exists；Current file equals proposed add content

- **Confirmed** `experiments\phase0-continues\.gitignore`：当前 exists；Current file equals proposed add content

- **Confirmed** `experiments\phase0-continues\run-baseline.mjs`：当前 exists；Added lines are present now; order, ownership and full historical patch success are not proven

- **Confirmed** `experiments\phase0-continues\verify-baseline.mjs`：当前 exists；Current file equals proposed add content

- **Confirmed** `experiments\phase0-continues\README.md`：当前 exists；Added lines are present now; order, ownership and full historical patch success are not proven

- **Confirmed** `experiments\phase1-distiller\package.json`：当前 exists；Current file equals proposed add content

- **Confirmed** `experiments\phase1-distiller\.gitignore`：当前 exists；Current file equals proposed add content

- **Confirmed** `experiments\phase1-distiller\evidence.mjs`：当前 exists；Added lines are present now; order, ownership and full historical patch success are not proven

- **Confirmed** `experiments\phase1-distiller\distiller.mjs`：当前 exists；Added lines are present now; order, ownership and full historical patch success are not proven

- **Confirmed** `experiments\phase1-distiller\run-distiller.mjs`：当前 exists；Added lines are present now; order, ownership and full historical patch success are not proven

- **Confirmed** `experiments\phase1-distiller\distiller.test.mjs`：当前 exists；Added lines are present now; order, ownership and full historical patch success are not proven

- **Confirmed** `experiments\phase1-distiller\evaluation.md`：当前 exists；Current file equals proposed add content

- **Confirmed** `experiments\phase1-distiller\README.md`：当前 exists；Current file equals proposed add content

## 接手建议（非当前动作结论）

- **Inferred** 先阅读已存在产物与当前相关文件，核对未返回调用及报告时间；仅执行确实缺失的下一步。复用经核对仍有效的文件与依赖，不直接重建或重装；不因旧 Session 的空待办数组就宣布任务完成。

## Evidence Pointers

- 快照：<repo>\docs\validation\recovery-handoffs-r7-full\session-01a070e6-3bd9-7591-aa4e-31b364badda1.jsonl
- SHA-256：a4ea79acaab9fe222bf899d1ed90fcceeca9441140953050ada3804d6354ee89
- Workspace：<repo>
- call:L<n>/op<m> 指向 evidence 的 operations；file:* / repo:git 指向 repo-truth。
- 接手时读证据而非直接执行历史代码片段。
