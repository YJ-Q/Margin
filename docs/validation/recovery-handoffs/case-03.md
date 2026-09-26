<!-- benchmark-case: case-03 | session-id: 01a0755d-e84a-7980-afaa-f98246f9436c | workspace-repo: <repo> -->
# Margin Smart Handoff

源 checkpoint：2026-09-07T02:50:22.550Z；Repo Truth：2026-09-07T02:50:22.803Z。
Confirmed = 句子描述的事实。Inferred = 解释/意图。Uncertain = 未能确认，不代表失败。

## 目标（历史请求，接手前请确认是否更新）

- **Inferred** # Margin V2 R1 — Floating Window Host Architecture

只调研，不修改代码。

## Goal

为 Margin V2 选择最简单可靠的 Floating Window 架构。

已完成：

- Margin CLI V1 RELEASE-READY
- Browser Workspace prototype
- Core Handoff pipeline
- Workspace / Session / Resume Summary / HANDOFF UX 已真实验证

V2 不重新设计产品逻辑，只把现有体验变成轻量桌面浮窗，同时长期保留 CLI。

## Compare

重点比较：

- Electron
- Tauri
- 其它足够成熟的轻量桌面/WebView方案

从以下角度比较：

- 是否能直接复用现有 React/Web UI
- 是否能调用本地 Node/Core 或等价 backend
- Windows 支持
- 安装包体积
- 内存占用
- 系统托盘 / always-on-top / hide-show
- 开发复杂度
- 打包/签名复杂度
- 社区成熟度
- 后续跨平台成本

优先成熟方案，不自研桌面 runtime。

## Architecture

目标结构应尽量保持：
```
                Margin Core
               /           \
           CLI V1        Floating V2
```

确认 GUI 应：

- 直接调用 Core
- 通过本地 backend 调 Core
- 还是复用现有 HTTP Surface

比较三者，选最简单且不会制造重复逻辑的方案。

## V2 minimum product

第一版浮窗只需要：

- Workspace Overview
- Recent Sessions
- Resume Summary
- Generate/Save HANDOFF
- Copy checkpoint

不要加入：

- live Agent monitoring
- usage
- launcher
- checkpoint lifecycle
- search/archive/delete\
  -复杂设置

## Output

1. Electron / Tauri / alternatives comparison
2. Recommended host
3. Core ↔ GUI architecture
4. Existing Browser code reuse
5. Packaging approach
6. V2 minimum window behavior
7. Biggest technical risks
8. First implementation slice
9. Acceptance criteria
10. Model ROI for implementation
11. `STOP — enough evidence for Floating Window V2`


## 当前状态

- **Confirmed** 当前仓库 <repo>；branch=main；HEAD=a247e75ab9e78cce7853e3f281b85459a4f25e7c；55 个已跟踪修改/未跟踪文件。

## Progress

- **Uncertain · Historical** Historical validation: unknown; no direct test result was recovered from the frozen Session.

- **Uncertain · Current** Current validation: unknown; historical tests have not been rerun against the current repository observation.

## Open Issues

- **Uncertain** 9 个内部操作在捕获证据中没有明确终态（含空补丁返回、裁剪）；这不是当前阻塞清单。已存在文件只能证明当前存在，不能倒推历史命令成功。

## 测试

- **Uncertain** 冻结 Session 未识别到直接测试执行/结果，不能声称测试已通过。

## 接手建议（非当前动作结论）

- **Inferred** 先阅读已存在产物与当前相关文件，核对未返回调用及报告时间；仅执行确实缺失的下一步。复用经核对仍有效的文件与依赖，不直接重建或重装；不因旧 Session 的空待办数组就宣布任务完成。

## Evidence Pointers

- 快照：C:\Temp\margin-recovery-handoff-staging-20260907\03\session-01a0755d-e84a-7980-afaa-f98246f9436c.jsonl
- SHA-256：9c0511185b1d49a1b1894f14ff8219fd6864256534e4b10bba94834f3edb9b5d
- Workspace：<repo>
- call:L<n>/op<m> 指向 evidence 的 operations；file:* / repo:git 指向 repo-truth。
- 接手时读证据而非直接执行历史代码片段。
