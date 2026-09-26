<!-- benchmark-case: case-10 | session-id: 01a07564-99fa-72e0-b086-4a21e5011211 | workspace-repo: <repo> -->
# Margin Smart Handoff

源 checkpoint：2026-09-07T02:50:45.072Z；Repo Truth：2026-09-07T02:50:45.342Z。
Confirmed = 句子描述的事实。Inferred = 解释/意图。Uncertain = 未能确认，不代表失败。

## 目标（历史请求，接手前请确认是否更新）

- **Inferred** # Margin V2.1 — Electron Floating Host

实现第一个 Floating Window vertical slice。

## Goal

把现有 Margin Browser Surface 原样运行在 Electron 中：
```
Margin Core
├─ CLI V1
└─ Electron V2
     ↓
 existing localhost HTTP Surface
     ↓
 existing React UI
```

不要重做 UI 或 Handoff 逻辑。

## Architecture

采用已确定方案：

- Electron main process
- `createMarginSurface({ port: 0, host: "127.0.0.1" })`
- BrowserWindow 加载返回的 localhost origin
- Renderer：
  - `nodeIntegration: false`
  - `contextIsolation: true`
- CLI 继续直接调用 Core
- React 继续通过现有 HTTP API
- 不新增 Electron 专属业务状态/IPC API

## Required behavior

实现：

1. 单实例
   - 再次启动只 show/focus 已有窗口
   - 不启动第二个 HTTP Surface
2. Floating Window
   - 初始约 `460×680`
   - 可 resize
   - 合理 min size
   - 默认不 always-on-top
3. Tray
   - Show/Hide
   - Always on top
   - Quit
4. Window lifecycle
   - Close → hide
   - Quit → 真正关闭 Window + HTTP Surface + process
5. Existing product flow 必须真实可用
   - Workspace Overview
   - Recent Sessions
   - Resume Summary
   - Copy checkpoint
   - Save `.margin/HANDOFF.md`

## Packaging

使用 Electron Forge。

要求生产包：

- 不依赖 Vite dev server
- 不依赖当前 shell cwd
- 不依赖全局 Node
- 正确找到 packaged `web/dist`
- localhost 使用 ephemeral port

先完成 Windows x64 **package/make + 本机 smoke test**。

本 Slice 不做：

- 正式 code signing
- auto-update
- CI release pipeline

### Native dependency

项目存在 `better-sqlite3`。

不要因为它重构 Core。

只确认 Electron package/build 不会因为 native ABI 导致启动失败；若 Forge 打包阶段因此阻塞，先定位最小 packaging 处理方案。

## Important

不要加入：

- Floating UI redesign
- live Agent monitoring
- usage
- Agent launcher
- checkpoint lifecycle
- search/archive/delete
- Workbench
- new IPC business transport

Electron 只是现有 Margin Surface 的桌面宿主。

## Validation

必须验证真实 packaged app，而不只是 dev mode：

- app 能启动
- 真实 Sessions / Workspaces 可见
- Generate/Copy/Save 真实 pipeline 可用
- `.margin/HANDOFF.md` 写入正确 Workspace
- Close → hide
- Tray show/hide
- Always-on-top toggle
- 第二次启动只聚焦原实例
- Quit 后 localhost listener 与 Electron process 均退出
- CLI V1 不回归
- focused tests + build + `git diff --check`

记录实际 package size 和启动/空闲资源占用即可，**只作为基线，不为优化数字改架构。**

## Output

1. Electron architecture
2. Lifecycle implementation
3. Packaging setup
4. Files changed
5. Tests
6. Packaged-app real validation
7. Tray / single-instance validation
8. Existing Margin flow regression
9. Package/resource baseline
10. Blockers/deviations
11. Verdict

最终：

`PASS — V2.1 Electron Host complete`

或

`PARTIAL — <specific blocker>`

完成后停止，不开始 V2.2。


## 当前状态

- **Confirmed** 当前仓库 <repo>；branch=main；HEAD=a247e75ab9e78cce7853e3f281b85459a4f25e7c；62 个已跟踪修改/未跟踪文件。

## Progress

- **Uncertain · Historical** Historical validation: unknown; no direct test result was recovered from the frozen Session.

- **Uncertain · Current** Current validation: unknown; historical tests have not been rerun against the current repository observation.

## Open Issues

- **Uncertain** 144 个内部操作在捕获证据中没有明确终态（含空补丁返回、裁剪）；这不是当前阻塞清单。已存在文件只能证明当前存在，不能倒推历史命令成功。

## 测试

- **Uncertain** 冻结 Session 未识别到直接测试执行/结果，不能声称测试已通过。

## Historical Intent

- **Inferred** Implemented:

## Current Applicability

- **Unknown** No structured repo targets are available for reconciliation.

## Evidence Pointers

- 快照：C:\Temp\margin-recovery-handoff-staging-20260907\10\session-01a07564-99fa-72e0-b086-4a21e5011211.jsonl
- SHA-256：e67c3558ccfaf9199c5590612dbde28938d38f7448a2af614bff9bf93a69080b
- Workspace：<repo>
- call:L<n>/op<m> 指向 evidence 的 operations；file:* / repo:git 指向 repo-truth。
- 接手时读证据而非直接执行历史代码片段。
