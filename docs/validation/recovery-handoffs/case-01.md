<!-- benchmark-case: case-01 | session-id: 01a077ec-bd2c-78a1-8581-c7440c9bda66 | workspace-repo: <repo> -->
# Margin Smart Handoff

源 checkpoint：2026-09-07T02:50:16.201Z；Repo Truth：2026-09-07T02:50:16.462Z。
Confirmed = 句子描述的事实。Inferred = 解释/意图。Uncertain = 未能确认，不代表失败。

## 目标（历史请求，接手前请确认是否更新）

- **Inferred** # Margin V2.2 — Agent Source Management



目标：完成进入真实使用前最后一个功能 Slice。

建立统一的：

`Agent Source Registry + Auto Detect + Manual Register + Adapter`

让 Margin 不依赖“自动猜到 Agent”。

## Core

CLI 和 Electron 必须共享同一 Source Registry。

Source 至少保存：

- id
- type
- name
- path
- auto/manual
- enabled
- supportLevel

不要保存 credential、token 或 Session 内容。

Adapter 保持最小：

- `detect`
- `validateSource`
- `discoverSessions`

不要重写现有 Codex parser/Handoff Core。

## Current support

### Codex

完整支持：

- 自动检测
- 手动指定 source path
- Session discovery
- 5h/7d Resource Status

路径优先级必须由 CLI/Electron 共用同一 resolver，并明确 manual path 与 env path 的 precedence。

### Claude

只做：

- Detect
- Manual source
- `Partial support`

不要实现 quota。

### Pi / DeepSeek Harness / Custom

允许用户注册路径，但当前没有 adapter 时显示：

`Registered · Adapter required`

不要生成假的 Sessions。

## CLI

增加最小命令：
```css
margin agent list
margin agent detect
margin agent add <type> --path <path>
margin agent remove <id>
```

不引入 TUI framework。

## Electron

现有 Settings 增加 `Agent Sources`。

支持：

- Auto Detect
- Add Source
- Change path
- Remove manual source

如果一个 supported Agent 都没找到，在 Board 区域提示：

`No supported Agent sources found`

并提供 Detect / Add Source。

不要做 onboarding wizard 或新窗口。

## Critical semantics

- 自动检测只是 convenience，不是唯一机制。
- 注册 Source ≠ 已支持该 Agent 格式。
- unsupported/custom Source 可以保存，但不能产生假 Session。
- Resource Bar 必须跟随当前生效 Codex Source，不能从另一个 Codex 路径读取 quota。
- CLI / Electron 必须看到相同 registry 和相同 active source。

## Validate

真实验证：

1. 标准 Codex 自动检测
2. CLI 手动 Codex → Electron 使用相同 Source
3. GUI 改 Codex Source → CLI 能看到
4. Custom/DeepSeek Source 可注册但无假 Session
5. Claude 显示 Partial
6. 没有 Agent 时 Margin 正常启动
7. Codex Session + Resource Bar + Copy/Save 无回归
8. 最新 installer 安装后无需 repo cwd / global Node 即可工作

跑 focused tests、build、Forge make。

## No-go

不要实现：

- Pi/DeepSeek parser
- generic JSONL parser
- Claude quota
- cloud sync
- credentials/OAuth
- database
- updater
- 新产品功能

## Output

报告：

- Registry / Adapter 设计
- path precedence
- CLI/GUI parity
- fresh-install smoke
- tests/build
- remaining blockers

最终：

`PASS — V2.2 Agent Source Management ready for real daily use`

或：

`PARTIAL — <blocker>`

通过后停止开发，进入真实 Daily-use Evaluation。


## 当前状态

- **Confirmed** 当前仓库 <repo>；branch=main；HEAD=a247e75ab9e78cce7853e3f281b85459a4f25e7c；53 个已跟踪修改/未跟踪文件。

## Progress

- **Uncertain · Historical** Historical validation: unknown; no direct test result was recovered from the frozen Session.

- **Uncertain · Current** Current validation: unknown; historical tests have not been rerun against the current repository observation.

## Open Issues

- **Uncertain** 34 个内部操作在捕获证据中没有明确终态（含空补丁返回、裁剪）；这不是当前阻塞清单。已存在文件只能证明当前存在，不能倒推历史命令成功。

## 测试

- **Uncertain** 冻结 Session 未识别到直接测试执行/结果，不能声称测试已通过。

## 接手建议（非当前动作结论）

- **Inferred** 先阅读已存在产物与当前相关文件，核对未返回调用及报告时间；仅执行确实缺失的下一步。复用经核对仍有效的文件与依赖，不直接重建或重装；不因旧 Session 的空待办数组就宣布任务完成。

## Evidence Pointers

- 快照：C:\Temp\margin-recovery-handoff-staging-20260907\01\session-01a077ec-bd2c-78a1-8581-c7440c9bda66.jsonl
- SHA-256：e365d348363b592e9cdfe8507cd55978c69daf62412b11c1d13c056306a6c26a
- Workspace：<repo>
- call:L<n>/op<m> 指向 evidence 的 operations；file:* / repo:git 指向 repo-truth。
- 接手时读证据而非直接执行历史代码片段。
