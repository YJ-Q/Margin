<!-- benchmark-case: case-11 | session-id: 01a076e8-fe17-7430-b1c4-b32715a65fe8 | workspace-repo: <repo> -->
# Margin Smart Handoff

源 checkpoint：2026-09-07T08:37:05.160Z；Repo Truth：2026-09-07T08:37:05.428Z。
Confirmed = 句子描述的事实。Inferred = 解释/意图。Uncertain = 未能确认，不代表失败。

## 目标（历史请求，接手前请确认是否更新）

- **Inferred** # Margin V2 UI — R3 First Implementation

基于已确认的 R3 线框实现第一版真实浮窗 UI。

目标：先实现结构与交互，不做高保真视觉打磨。

## Structure

### Usage Bar

- 高约 44px
- 去掉 `Margin` 标题
- 左侧固定：`Today <tokens>`
- 中间：各模型/Agent Token 用量，单行横向滚动
- 右侧固定：展开/收起
- 不显示 trend、Workspace/Session 数量或其它 Usage 详情
- 点击 Bar 展开/收起 Session Board

### Session Board

三种互斥浏览模式：

- Workspace
- Agent
- Sessions

要求：

- Workspace：按 workspace 聚合
- Agent：按 agent 聚合
- Sessions：不聚合，按现有 source/session 顺序平铺
- 不增加搜索、筛选、标签、自定义排序等功能

### Session Row

保持单行、约 36px。

只显示：

- 状态点
- Agent（若当前分组已表达 Agent，则不重复）
- Session title
- Workspace/context（若当前分组已表达，则不重复）
- relative time

title 超长 ellipsis，不换行。

### Hover handoff

不要展开箭头，不要三级页面。

Hover 某条 Session：

- 行尾出现 `Copy`、`Save`
- time 与临近 context 在按钮区域附近淡化/轻微 blur
- 其它行不变
- mouse leave 恢复
- Copy / Save 直接使用该 Session 的 Handoff
- 不展示 Resume Summary / Goal / Progress / Validation / preview

## Visual scope

只做：

- 基础 spacing
- typography hierarchy
- divider
- hover
- selected mode
- overflow/scroll

不要：

- 品牌视觉重做
- 动效设计
- 复杂图标
- dark mode
- 大范围 CSS 重构

## Validate

在真实 Electron 浮窗中验证：

1. collapsed bar
2. expand/collapse
3. model token 横向滚动
4. Workspace mode
5. Agent mode
6. Sessions mode
7. long title ellipsis
8. hover Copy / Save
9. real handoff Copy
10. real handoff Save
11. Board overflow vertical scroll
12. resize 不破版

同时确认 CLI V1 / existing Handoff Core 无回归。

## Output

1. 实现截图
2. 主要改动文件
3. 实际交互结果
4. 发现的 UX 问题
5. tests/build
6. verdict

最终：

`PASS — R3 first implementation ready for UX iteration`

或：

`PARTIAL — <blocker>`

完成后停止，不继续自行美化或加功能。


## 当前状态

- **Confirmed** 当前仓库 <repo>；branch=main；HEAD=a247e75ab9e78cce7853e3f281b85459a4f25e7c；250 个已跟踪修改/未跟踪文件。

## Progress

- **Uncertain · Historical** Historical validation: unknown; no direct test result was recovered from the frozen Session.

- **Uncertain · Current** Current validation: unknown; historical tests have not been rerun against the current repository observation.

## Historical Report

- **Inferred · Historical** PARTIAL — 真实 Electron 环境没有可用 Session 数据，剩余数据态验收无法执行。

- **Inferred · Historical** Terminal assistant report (excerpt): 已完成 R3 第一版结构与交互实现。 ![真实 Electron 折叠浮窗截图](/<repo>/docs/validation/r3-electron-window.png) 主要改动： - [SessionBoard.js](/<repo>/web/src/margin/SessionBoard.js)：Usage Bar、三种 Board 分组、单行 Session、hover Copy/Save。 - [MarginApp.js](/<repo>/web/src/margin/MarginApp.js)：移除旧的“列表 + 详情”流程，改为折叠/展开浮窗。 - [margin.css](/<repo>/web/src/margin/margin.css)：R3 的基础布局、滚动、ellipsis、hover 与响应式。 - [httpAdapter.js](/<repo>/src/core/handoff/httpAdapter.js)：暴露安全的 session bytes，用于明确标为 `~` 的本地 token 估算。 - [ 验证结果： - `npm run build`：通过。 - R3/UI、Handoff Core、CLI、Electron host 定向测试：62/62 通过。 - Electron 真实浮窗：成功启动并验证 collapsed bar。 - 当前宿主发现到 0 个可恢复 Codex sessions，因此无法在真实浮窗中完成 Workspace/Agent/Sessions 内容、长标题、hover、真实 Copy/Save、纵向溢出及 resize 的数据态验证；这些交互已由组件测试覆盖。 PARTIAL — 真实 Electron 环境没有可用 Session 数据，剩余数据态验收无法执行。

## Historical Pending / Blockers

- **Inferred · Historical** 剩余数据态验收无法执行。

## 失败 / 已拒绝

- **Confirmed** 命令进程失败：Get-Content package.json; Get-Content web/src/margin/MarginApp.js; Get-Content web/src/margin/margin.css; Get-Content electron/main.js -ErrorAction SilentlyContinue; rg -n "Marg...；exit_code=1

- **Confirmed** 命令进程失败：npm run build; npm test -- --test-name-pattern "(margin|handoff|electron)"；exit_code=1

- **Confirmed** 命令进程失败：.\.runtime\node-v22.23.1-win-x64\node.exe .\node_modules\electron\cli.js .\scripts\capture-r3-electron.mjs；exit_code=1

- **Confirmed** 命令进程失败：$env:ELECTRON_ENABLE_LOGGING='1'; .\.runtime\node-v22.23.1-win-x64\node.exe .\node_modules\electron\cli.js .\scripts\capture-r3-electron.mjs --enable-logging；exit_code=1

- **Confirmed** 命令进程失败：Stop-Process -Name electron -Force -ErrorAction SilentlyContinue; .\.runtime\node-v22.23.1-win-x64\node.exe .\node_modules\electron\cli.js .\scripts\capture-r3-electron.js；exit_code=1

- **Confirmed** 命令进程失败：npm run electron:start；exit_code=1

## Open Issues

- **Uncertain** 50 个内部操作在捕获证据中没有明确终态（含空补丁返回、裁剪）；这不是当前阻塞清单。已存在文件只能证明当前存在，不能倒推历史命令成功。

## 测试

- **Uncertain** 冻结 Session 未识别到直接测试执行/结果，不能声称测试已通过。

## 接手建议（非当前动作结论）

- **Inferred** 先阅读已存在产物与当前相关文件，核对未返回调用及报告时间；仅执行确实缺失的下一步。复用经核对仍有效的文件与依赖，不直接重建或重装；不因旧 Session 的空待办数组就宣布任务完成。

## Evidence Pointers

- 快照：<repo>\docs\validation\recovery-handoffs-postfix-r4\session-01a076e8-fe17-7430-b1c4-b32715a65fe8.jsonl
- SHA-256：63cdb8e06094ba0e4ee944988fe30a13a1303f8dd04c5c61b386de6bdda96ef3
- Workspace：<repo>
- call:L<n>/op<m> 指向 evidence 的 operations；file:* / repo:git 指向 repo-truth。
- 接手时读证据而非直接执行历史代码片段。
