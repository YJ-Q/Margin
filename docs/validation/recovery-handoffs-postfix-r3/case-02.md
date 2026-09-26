<!-- benchmark-case: case-02 | session-id: 01a074ec-9f30-7c62-bb5f-257091ef242a | workspace-repo: <repo> -->
# Margin Smart Handoff

源 checkpoint：2026-09-07T08:36:45.449Z；Repo Truth：2026-09-07T08:36:45.727Z。
Confirmed = 句子描述的事实。Inferred = 解释/意图。Uncertain = 未能确认，不代表失败。

## 目标（历史请求，接手前请确认是否更新）

- **Inferred** 做 Margin Slice 3.3 R1，只调研，不修改代码。

## Goal

定义最小 Workspace Overview，让用户不用逐个打开 Session，也能判断：

- 这个 Workspace 最近在做什么
- 最近有什么进展
- 当前 repo 有什么可观察状态
- 应该打开哪个 Session 继续

同时禁止推断跨 Session 的“总任务状态”。

## 已知基础

已有：

- Workspace grouping / identity
- resumable Sessions
- per-Session Resume Summary
- Distiller / Repo Truth / Current Applicability
- Session updatedAt / branch / label
- Select → fresh checkpoint → Copy

## 重点回答

### 1. Workspace overview 的事实来源

分别判断哪些可以安全来自：

- most recent resumable Session
- multiple recent Sessions
- current Repo Truth

明确 historical session fact 与 current workspace observation 的边界。

### 2. “最近工作”选择规则

判断 V1 是否应直接使用：

`most recent resumable Session by updatedAt`

作为 Workspace Overview 的 session-derived source。

检查真实情况是否会被：

- research Session
- implementation Session
- 不同 branch
- 并行 Session

误导。

如果不能可靠代表 Workspace 总状态，就明确命名为：

`Latest session`

而不是：

`Current workspace state`

### 3. 最小 Overview 内容

从下面收敛到 3–5 项：

- latest session label / goal
- progress
- branch
- updated time
- current repo observation
- current applicability
- validation
- session count

每项说明用户决策价值。

### 4. Current repo truth

判断 Workspace 层最多能安全显示什么，例如：

- current branch / HEAD
- dirty state
- historical targets currently observable

不能从 repo facts 推断 task completion。

### 5. 多 Session 规则

明确禁止或允许哪些聚合。

重点回答：

- 是否 merge Goals？
- 是否 merge Progress？
- 是否 merge Validation？
- 是否只显示 latest session + workspace facts？
- 是否需要显示“还有 N 个其他 recent sessions”？

优先最保守、可解释方案。

### 6. Open action

定义主动作。

候选：

- Open latest session
- Continue latest session
- View sessions

不要使用会暗示 Workspace 本身已有统一 resumable state 的文案。

### 7. API / data contract

检查现有 `/api/sessions` 是否足够客户端生成 Overview。

如果需要新 API，定义最小 DTO。

不要重复生成所有 Session 的完整 Handoff，除非有证据证明必要且成本可接受。

### 8. Real sample check

至少检查一个真实 multi-session Workspace（优先 Margin）。

验证 Overview 是否会因为 research / implementation / branch 差异产生误导。

## 输出

1. Workspace truth model
2. Latest-session selection rule
3. Overview fields
4. Multi-session aggregation rules
5. Repo-truth boundary
6. Primary action
7. API decision
8. Real Workspace validation
9. Recommended Slice 3.3 implementation objective
10. Acceptance criteria
11. Model ROI for implementation
12. `STOP — enough evidence for Slice 3.3` 或具体 blocker

不要实现，不研究跨 Agent launcher、live monitoring、usage 或 checkpoint lifecycle。


## 当前状态

- **Confirmed** 当前仓库 <repo>；branch=main；HEAD=a247e75ab9e78cce7853e3f281b85459a4f25e7c；222 个已跟踪修改/未跟踪文件。

## Progress

- **Uncertain · Historical** Historical validation: unknown; no direct test result was recovered from the frozen Session.

- **Uncertain · Current** Current validation: unknown; historical tests have not been rerun against the current repository observation.

## Historical Report

- **Inferred · Historical** "available" | "unavailable",

- **Inferred · Historical** Terminal assistant report (excerpt): ## 2. Latest-session selection rule V1 使用： `most recent resumable Session by updatedAt, then id desc` 但 UI 名称必须是 **Latest session**，不能叫 “Current workspace state”。 原因：真实 Margin 样本中最新 Session 是本次 Slice 3.3 调研；前一个是 Phase 3 Midpoint 调研；更早才是 Slice 3.2 实现。若把最新调研说成 Workspace 当前状态，会遮蔽最近的实现工作。`updatedAt` 也只是 discovery 的排序时间，不是可靠的“最后实际开发时间”。 建议 5 项： 1. **Latest session**：label/短目标、updated time、Session branch。帮助用户判断先打开哪条。 2. **Latest-session progress**：最多一条有来源的历史进展；没有则明确 “No source-backed progress”。不拿更早 Session 补齐。 3. **Current repo**：current branch、短 HEAD、dirty count、observedAt。帮助判断是否在预期 checkout、是否存在未提交变更。 4. **Latest-session applicability**：仅显示“该 Session 的 structured historical targets 当前可观察性” 最小建议： ```ts GET /api/workspace-overview?workspaceKey=... { workspace: { ## 8. Real Workspace validation 检查了真实 Margin Workspace： - 当前发现 **27** 个 resumable Sessions，全部在 `main`；因此 branch 差异尚无真实本地样本，不能把缺少差异误当作安全保证。 - 最新 Session 是本次 **Slice 3.3 R1 调研**；前一个是 **Phase 3 Midpoint R0 调研**；更早是 **Slice 3.2 实现**。这证实“最新 Session = Workspace 当前任务状态”会误导。 - 当前 repo 为 `main`、HEAD `0836e800…`、71 个 dirty/untracked entries；这些变更不能归因给最新调研 Session。 ## 12. Stop verdict **STOP — enough evidence for Slice 3.3**

## Open Issues

- **Uncertain** 8 个内部操作在捕获证据中没有明确终态（含空补丁返回、裁剪）；这不是当前阻塞清单。已存在文件只能证明当前存在，不能倒推历史命令成功。

## 测试

- **Uncertain** 冻结 Session 未识别到直接测试执行/结果，不能声称测试已通过。

## Historical Intent

- **Inferred** updatedAt: string | null,

## Current Applicability

- **Unknown** No structured repo targets are available for reconciliation.

## Evidence Pointers

- 快照：<repo>\docs\validation\recovery-handoffs-postfix-r3\session-01a074ec-9f30-7c62-bb5f-257091ef242a.jsonl
- SHA-256：cee475775fdb647f3650306c43c12f7026721769b637b6f5651a2b5f0f386c96
- Workspace：<repo>
- call:L<n>/op<m> 指向 evidence 的 operations；file:* / repo:git 指向 repo-truth。
- 接手时读证据而非直接执行历史代码片段。
