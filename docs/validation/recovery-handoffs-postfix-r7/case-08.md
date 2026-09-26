<!-- benchmark-case: case-08 | session-id: 01a0763e-bfe9-77f1-b669-900b837d2754 | workspace-repo: <repo> -->
# Margin Smart Handoff

源 checkpoint：2026-09-07T08:39:04.376Z；Repo Truth：2026-09-07T08:39:04.639Z。
Confirmed = 句子描述的事实。Inferred = 解释/意图。Uncertain = 未能确认，不代表失败。

## 目标（历史请求，接手前请确认是否更新）

- **Inferred** # Margin Repository Cleanup — Slice 1

按 cleanup audit 执行第一轮主线收敛。

不要扩大到旧架构整体删除。

## Goal

让仓库默认开发、构建、运行和打包路径只指向当前 Margin 主线：

`CLI V1 + src/core/handoff + Electron V2 + web/src/margin`

旧 Workbench / Workstream / Run / Memory 暂时保留，但只能通过明确 legacy 入口访问。

## Do

1. 把默认 `start/dev`、Docker、`run-margin-local.cmd` 切到当前 Margin Surface。
2. Vite 默认只构建 `margin.html`，不再把旧 `index.html` 作为默认 build input。
3. 删除审计已确认无引用的 11 个旧 `.jsx` wrapper 文件。
4. 清理本地 generated artifacts：
   - `out*`
   - `out-electron*`
   - `.worktrees`
   - `handoff-output`
   - 临时 Electron logs/runtime artifacts\
     不删除源码或数据资产。
5. Forge packaging ignore 增加明确无效目录，至少避免 `.worktrees` / 旧 build output 再进入 installer。
6. 如需保留旧 Workbench 启动能力，改成明确 legacy script，例如：\
   `legacy:workbench`\
   不要完全删除。

## Do not

不要删除：

- `src/application`
- `src/continuity`
- `src/contracts`
- `src/domain`
- `src/http`
- `src/runtime`
- `src/pilot`
- migrations / data
- Feishu
- evaluation / docs

这些留到后续单独退役。

## Validate

至少：

- CLI V1 可运行
- Electron Margin Surface 可启动
- `npm run build` 只生成当前 Margin Web entry
- focused current-mainline tests 通过
- Electron package 不再包含 `.worktrees`
- `git diff --check`

记录清理前后：

- repo generated-artifact 状态
- Web build 内容
- Electron package size（只记录，不继续优化）

## Output

1. Default entry changes
2. Deleted safe wrappers
3. Generated cleanup
4. Packaging ignore changes
5. Legacy paths retained
6. Tests/build
7. Package-size comparison
8. Remaining retire candidates
9. Verdict

最终：

`PASS — Repository mainline cleanup complete`

或

`PARTIAL — <specific blocker>`

完成后停止，不继续删除 legacy stack。


## 当前状态

- **Confirmed** 当前仓库 <repo>；branch=main；HEAD=a247e75ab9e78cce7853e3f281b85459a4f25e7c；295 个已跟踪修改/未跟踪文件。

## Progress

- **Confirmed · Historical** Historical validation: 1 focused test command failed.

- **Uncertain · Historical** Historical validation: 1 focused test command had no explicit final result.

- **Uncertain · Current** Current validation: unknown; historical tests have not been rerun against the current repository observation.

## Historical Report

- **Inferred · Historical** PARTIAL — cleanup is complete except for two externally locked historical `app.asar` files and installer creation blocked by missing host Python.

- **Inferred · Historical** Terminal assistant report (excerpt): PARTIAL — cleanup is complete except for two externally locked historical `app.asar` files and installer creation blocked by missing host Python. 1. Default entry changes - `start`, `dev`, Docker, Compose, and `run-margin-local.cmd` now launch Margin Surface. - Vite builds only `margin.html`. - Workbench retained solely as `legacy:workbench`. 2. Deleted safe wrappers - Removed 11 unused legacy PARTIAL — cleanup is complete except for two externally locked historical `app.asar` files and installer creation blocked by missing host Python. 1. Default entry changes - `start`, `dev`, Docker, Compose, and `run-margin-local.cmd` now launch Margin Surface. - Vite builds only `margin.html`. - Workbench retained solely as `legacy:workbench`. 6. Tests/build - `npm run build` passes; output contains only `margin.html`, Margin JS, and Margin CSS. - `npm start` successfully started Margin Surface on loopback. - Focused current-mainline suite: 76/76 passing. - Electron V2 host lifecycle test passes.

## Historical Pending / Blockers

- **Inferred · Historical** blocked by missing host Python.

## 失败 / 已拒绝

- **Confirmed** 命令进程失败：Get-Content src/core/handoff/createMarginSurface.js; Get-Content electron/main.js; Get-Content electron/preload.js; Get-Content scripts/run-margin-surface.js; Get-Content web/sr...；exit_code=1

- **Confirmed** 命令进程失败：npm test -- --test-name-pattern="^$"; & .\.runtime\node-v22.23.1-win-x64\node.exe --test test/marginCli.test.js test/handoff.test.js test/marginSurfaceHttpAdapter.test.js test/m...；exit_code=1

- **Confirmed** 命令进程失败：npm run electron:package；Error: Could not find any Python installation to use

- **Confirmed** 命令进程失败：$env:MARGIN_SURFACE_PORT='0'; npm start；exit_code=-1

## Open Issues

- **Uncertain** 26 个内部操作在捕获证据中没有明确终态（含空补丁返回、裁剪）；这不是当前阻塞清单。已存在文件只能证明当前存在，不能倒推历史命令成功。

## 测试

- **Confirmed** 测试命令 npm test -- --test-name-pattern="^$"; & .\.runtime\node-v22.23.1-win-x64\node.exe --test test/marginCli.test.js test/handoff.test.js test/marginSurfaceHttpAdapter.test.js test/m...：failed；exit_code=1。

- **Uncertain** 测试命令 npm test -- --test-name-pattern="^$"; & .\.runtime\node-v22.23.1-win-x64\node.exe --test test/marginCli.test.js test/handoff.test.js test/marginSurfaceHttpAdapter.test.js test/m...：unknown；No explicit success/failure in result。

## 接手建议（非当前动作结论）

- **Inferred** 先阅读已存在产物与当前相关文件，核对未返回调用及报告时间；仅执行确实缺失的下一步。复用经核对仍有效的文件与依赖，不直接重建或重装；不因旧 Session 的空待办数组就宣布任务完成。

## Evidence Pointers

- 快照：<repo>\docs\validation\recovery-handoffs-postfix-r7\session-01a0763e-bfe9-77f1-b669-900b837d2754.jsonl
- SHA-256：c1d19296db2704a7f9e79b8d4cde6cb06bed6f206fd41c6ab4e0e94c1f14c56f
- Workspace：<repo>
- call:L<n>/op<m> 指向 evidence 的 operations；file:* / repo:git 指向 repo-truth。
- 接手时读证据而非直接执行历史代码片段。
