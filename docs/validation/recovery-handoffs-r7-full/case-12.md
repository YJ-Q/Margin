<!-- benchmark-case: case-12 | session-id: 01a07770-d875-7b51-bd03-e154fe30c66c | workspace-repo: <repo> -->
# Margin Smart Handoff

源 checkpoint：2026-09-07T09:27:29.661Z；Repo Truth：2026-09-07T09:27:29.969Z。
Confirmed = 句子描述的事实。Inferred = 解释/意图。Uncertain = 未能确认，不代表失败。

## 目标（历史请求，接手前请确认是否更新）

- **Inferred** Margin V2 UI R3.3 — Responsive Controls + Refresh + Settings + Save Feedback
基于 R3.2 / R3.1 真实 Electron 浮窗继续。
本轮只修真实使用问题，不改产品主线，不新增大功能。
Goal
让当前浮窗在不同宽度下保持稳定单行布局，并补齐：
\- 一级右侧窗口控制
\- 新 Session 刷新
\- Save 路径反馈
\- 设置页
\- Session row 响应式
\- Toast 不遮挡/不堆叠
真实 Token Usage 仍不实现。
1\. Usage Bar 响应式结构
一级横条继续保持约 44px、高度单行。
结构固定为：
Today fixed | Usage viewport flex/scroll | Expand | Window controls overlay
要求：
Today
\- 左侧固定
\- 不与第一个 Agent Usage 紧贴
\- 保持明确间距
Usage viewport
\- 中间唯一弹性区域
\- 多个 model/agent usage 横向排列
\- 横向 overflow 时滚动
\- 隐藏传统 scrollbar
\- 左右可用轻微 edge fade
\- 不允许模型 Usage 把整条 Window 撑宽
Right Control Dock
右侧固定 overlay，不参与 Usage content width 计算。
顺序：
▾/▴   Quit   Hide   Pin
均保持同一水平线。
不要采用 macOS 三圆点。
视觉要求：
\- 极小、低存在感
\- 真实点击热区约 22–24px
\- Quit：默认 neutral，hover 才显示危险态
\- Hide：neutral
\- Pin：未开启 neutral；Always-on-top active 时显示明显 active state
\- tooltip：Quit / Hide / Pin
\- Control Dock 左侧保留 fade/padding，避免 Usage 文字被按钮直接覆盖
窗口 resize 时：
\- Today 和右侧 controls 不变
\- 只压缩 Usage viewport
\- 不增加一级横条高度
2\. Window controls semantics
Quit
彻底退出 Margin：
\- tray
\- Surface
\- Electron process
全部正常关闭。
Hide
只隐藏浮窗到 Tray：
\- process 不退出
\- Surface 不关闭
Pin
切换 Always on top：
\- active state 明确
\- 与 Tray 内 existing always-on-top state 同步
\- 两边修改必须保持一致
3\. Session Board mode header
保持：
Workspace   Agent   Sessions                    Settings
Settings 是独立图标入口，不做第四个普通 tab。
点击 Settings：
\- 不打开 modal
\- 不打开新窗口
\- 不展开 drawer
\- 直接复用当前 Session Board 内容区域显示 Settings
返回后恢复之前使用的 Workspace / Agent / Sessions mode。
4\. Settings — first minimal version
只实现当前已经明确需要的设置。
Display
Show workspace/session summary
\- default OFF
\- 开启后允许 Usage Bar 显示类似：
&#x20; 3 workspaces · 31 sessions
\- 关闭后一级不显示
\- 不影响 Session Board
Window
Always on top
\- 与 Pin 按钮实时同步
Feedback
Save confirmation：
\- Full path（default）
\- Compact
Full path：
✓ Saved · <repo>\\.margin\HANDOFF.md
Compact：
✓ Saved
错误信息不受 Compact 影响，始终显示具体失败原因。
不要增加其它设置。
设置状态使用最轻量的 local persistence，优先复用现有 Electron/local UI capability；不要引入新的 settings framework/database。
5\. Session Row 响应式布局
所有 Session 继续保持单行。
结构：
status | agent/context | title:flex | right-slot:fixed
核心规则：
Right slot
最右侧永远固定。
Normal：
30m
Hover：
Copy  Save
Copy / Save 和 time 使用同一个固定槽位，不重新参与 layout。
要求：
\- time 永远靠最右
\- hover 后整行不位移
\- Copy/Save 不把 title 往左突然推
\- 不换行
Title
title 是唯一主要伸缩列：
\- min-width: 0
\- ellipsis
\- 窄窗口时优先压缩 title
Mode-specific context
Workspace mode：
\- group header 已包含 workspace
\- row 不重复 workspace
Agent mode：
\- group header 已包含 agent
\- row 显示 workspace/context
Sessions mode：
\- row 显示 Agent + 简短 workspace/context
不要重复已经被 group header 表达的信息。
不同窗口宽度下不得出现：
\- 左侧重叠
\- 右侧巨大空白但左侧拥挤
\- time 漂移
\- 行高增加
6\. New Session refresh
解决“新开会话后 Board 不出现”的问题。
保持轻量，不进入 Live Monitoring。
至少：
\- Board expand 时 refresh
\- Electron window focus 时 refresh
\- expanded 状态下约每 30 秒 refresh
\- collapse 后停止周期 refresh
要求：
\- 复用现有 Core discovery
\- 不重新实现 runtime monitor
\- 不引入 file watcher/live hook
\- 不改变 resumable filtering
刷新时尽量保持：
\- 当前 mode
\- scroll position（合理情况下）
\- Settings state
\- 不明显闪烁整个列表
用真实新开的 Codex Session 做验收。
7\. Save correctness
当前用户点击 Save 后没有在预期 Workspace 看到文件。
必须重新真实验证：
\<selected-session-workspace>/.margin/HANDOFF.md
检查：
\- selected session workspace resolution
\- save API response
\- actual filesystem path
\- success/error handling
不要只根据 HTTP 200 显示 Saved。
成功前必须确认实际 write 成功。
8\. Global Toast
保留现在黑色醒目提示风格，但改成窗口级 overlay。
不要把 Toast 放在 Session row / scroll container 内。
要求：
\- 靠 Board/Window 右侧
\- high z-index
\- 不被 list overflow 裁剪
\- 不推动布局
\- single-line only
\- max width <= current Session Board width
\- 路径过长 ellipsis
\- 默认显示约 1.5–2 秒
Full path example：
✓ Saved · <repo>\\.margin\HANDOFF.md
Multiple Save behavior
不要堆 Toast。
采用单一 Toast slot：
\- 新 Save 替换当前 Toast 内容
\- reset dismiss timer
\- 始终只显示最新操作结果
不要实现 toast queue / stack。
Copy 成功也可以复用同一 Toast：
✓ Copied
错误：
Save failed · \<specific reason>
错误不要自动过度简化。
9\. Token Usage
本轮不要实现真实 Token Source。
继续显示：
Today —
Codex —
等价 unavailable state。
不要恢复：
\- bytes estimate
\- message length estimate
\- fake token
\- trend
真实 Usage Source 下一 Slice 单独研究。
Validate in real Electron
必须真实验证：
1\. Usage Bar 不因 controls 被撑宽
2\. Today / first Usage 不挤压
3\. narrow / medium / wide window responsive
4\. controls Quit / Hide / Pin
5\. Pin 与 Tray 同步
6\. Settings 在 Board 原区域显示
7\. setting persistence
8\. workspace/session summary toggle
9\. Full path / Compact toast setting
10\. Workspace mode row layout
11\. Agent mode row layout
12\. Sessions mode row layout
13\. time 固定最右
14\. hover Copy/Save 无位移
15\. long title ellipsis
16\. new real Session 在 refresh 后出现
17\. Save 实际生成正确 workspace .margin/HANDOFF.md
18\. Toast 不被顶部/scroll container 遮挡
19\. 连续 Save 不堆叠
20\. Board vertical overflow
21\. CLI/Core 无回归
同时：
\- focused tests
\- npm run build
\- git diff --check
Output
1\. Before/after screenshots
2\. Usage Bar responsive result
3\. Window controls result
4\. Settings screenshot
5\. three Board mode screenshots
6\. hover screenshot
7\. new-session refresh smoke
8\. actual Save path smoke
9\. Toast behavior
10\. tests/build
11\. remaining UX issues，最多 3 个
12\. files changed
最终：
PASS — R3.3 ready for continued daily-use
或
PARTIAL — \<specific blocker>
完成后停止。
不要继续实现真实 Token Usage、搜索、标签、Live Agent Monitor、复杂设置或新的视觉重构。


## 当前状态

- **Confirmed** 当前仓库 <repo>；branch=main；HEAD=a247e75ab9e78cce7853e3f281b85459a4f25e7c；355 个已跟踪修改/未跟踪文件。

## Progress

- **Confirmed · Historical** Historical validation: 3 focused test commands exited 0.

- **Uncertain · Historical** Historical validation: 3 focused test commands had no explicit final result.

- **Uncertain · Current** Current validation: unknown; historical tests have not been rerun against the current repository observation.

## Historical Report

- **Inferred · Historical** PASS — R3.3 ready for continued daily-use.

- **Inferred · Historical** Terminal assistant report (excerpt): PASS — R3.3 ready for continued daily-use. - Responsive usage bar: fixed Today, scrollable usage viewport, overlay control dock; narrow/medium/wide rendering verified. Token state remains unavailable (`Today —`, `Codex —`). - Window controls: Expand, Quit, Hide, Pin added. Pin synchronizes with Tray’s Always-on-top item. - Settings: in-board Settings view with persisted summary toggle, Always-on- PASS — R3.3 ready for continued daily-use. - Responsive usage bar: fixed Today, scrollable usage viewport, overlay control dock; narrow/medium/wide rendering verified. Token state remains unavailable (`Today —`, `Codex —`). - Window controls: Expand, Quit, Hide, Pin added. Pin synchronizes with Tray’s Always-on-top item. - Settings: in-board Settings view wi Validation: - Focused Electron/UI/Core tests: 15 passed. - CLI/discovery tests: 13 passed. - `npm run build`: passed. - `git diff --check`: passed.

## 已完成（事实范围）

- **Confirmed** 历史命令进程已成功返回：npm test -- --test-name-pattern "R3 board|Electron host|handoff/save"; npm run build; git diff --check（exit_code=0）；不代表之后文件仍未变化。

- **Confirmed** 历史命令进程已成功返回：.\.runtime\node-v22.23.1-win-x64\node.exe --test test/electronHost.test.js test/marginR3Board.test.js test/marginSurfaceHttpAdapter.test.js; npm run build; git diff --check（exit_code=0）；不代表之后文件仍未变化。

- **Confirmed** 历史命令进程已成功返回：.\.runtime\node-v22.23.1-win-x64\node.exe --test test/marginCli.test.js test/marginDiscoveryParity.test.js; git diff --check; Get-ChildItem docs/validation/r3.3 | Select-Object ...（exit_code=0）；不代表之后文件仍未变化。

## Open Issues

- **Uncertain** 33 个内部操作在捕获证据中没有明确终态（含空补丁返回、裁剪）；这不是当前阻塞清单。已存在文件只能证明当前存在，不能倒推历史命令成功。

## 测试

- **Confirmed** 测试命令 npm test -- --test-name-pattern "R3 board|Electron host|handoff/save"; npm run build; git diff --check：succeeded；exit_code=0。

- **Confirmed** 测试命令 .\.runtime\node-v22.23.1-win-x64\node.exe --test test/electronHost.test.js test/marginR3Board.test.js test/marginSurfaceHttpAdapter.test.js; npm run build; git diff --check：succeeded；exit_code=0。

- **Confirmed** 测试命令 .\.runtime\node-v22.23.1-win-x64\node.exe --test test/marginCli.test.js test/marginDiscoveryParity.test.js; git diff --check; Get-ChildItem docs/validation/r3.3 | Select-Object ...：succeeded；exit_code=0。

- **Uncertain** 测试命令 npm test -- --test-name-pattern "R3 board|Electron host|handoff/save"; npm run build; git diff --check：unknown；No explicit success/failure in result。

- **Uncertain** 测试命令 .\.runtime\node-v22.23.1-win-x64\node.exe --test test/electronHost.test.js test/marginR3Board.test.js test/marginSurfaceHttpAdapter.test.js; npm run build; git diff --check：unknown；No explicit success/failure in result。

- **Uncertain** 测试命令 .\.runtime\node-v22.23.1-win-x64\node.exe --test test/marginCli.test.js test/marginDiscoveryParity.test.js; git diff --check; Get-ChildItem docs/validation/r3.3 | Select-Object ...：unknown；No explicit success/failure in result。

## 接手建议（非当前动作结论）

- **Inferred** 先阅读已存在产物与当前相关文件，核对未返回调用及报告时间；仅执行确实缺失的下一步。复用经核对仍有效的文件与依赖，不直接重建或重装；不因旧 Session 的空待办数组就宣布任务完成。

## Evidence Pointers

- 快照：<repo>\docs\validation\recovery-handoffs-r7-full\session-01a07770-d875-7b51-bd03-e154fe30c66c.jsonl
- SHA-256：f289ddbdd0146cd09c5c2f63ceebba74392a52ec4295b1eb7c572b45af162fb7
- Workspace：<repo>
- call:L<n>/op<m> 指向 evidence 的 operations；file:* / repo:git 指向 repo-truth。
- 接手时读证据而非直接执行历史代码片段。
