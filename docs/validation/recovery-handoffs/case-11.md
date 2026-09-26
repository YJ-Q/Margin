<!-- benchmark-case: case-11 | session-id: 01a076e8-fe17-7430-b1c4-b32715a65fe8 | workspace-repo: <repo> -->
# Margin Smart Handoff

源 checkpoint：2026-09-07T02:50:48.245Z；Repo Truth：2026-09-07T02:50:48.510Z。
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

- **Confirmed** 当前仓库 <repo>；branch=main；HEAD=a247e75ab9e78cce7853e3f281b85459a4f25e7c；63 个已跟踪修改/未跟踪文件。

## Progress

- **Uncertain · Historical** Historical validation: unknown; no direct test result was recovered from the frozen Session.

- **Uncertain · Current** Current validation: unknown; historical tests have not been rerun against the current repository observation.

## Open Issues

- **Uncertain** 50 个内部操作在捕获证据中没有明确终态（含空补丁返回、裁剪）；这不是当前阻塞清单。已存在文件只能证明当前存在，不能倒推历史命令成功。

## 测试

- **Uncertain** 冻结 Session 未识别到直接测试执行/结果，不能声称测试已通过。

## 接手建议（非当前动作结论）

- **Inferred** 先阅读已存在产物与当前相关文件，核对未返回调用及报告时间；仅执行确实缺失的下一步。复用经核对仍有效的文件与依赖，不直接重建或重装；不因旧 Session 的空待办数组就宣布任务完成。

## Evidence Pointers

- 快照：C:\Temp\margin-recovery-handoff-staging-20260907\11\session-01a076e8-fe17-7430-b1c4-b32715a65fe8.jsonl
- SHA-256：63cdb8e06094ba0e4ee944988fe30a13a1303f8dd04c5c61b386de6bdda96ef3
- Workspace：<repo>
- call:L<n>/op<m> 指向 evidence 的 operations；file:* / repo:git 指向 repo-truth。
- 接手时读证据而非直接执行历史代码片段。
