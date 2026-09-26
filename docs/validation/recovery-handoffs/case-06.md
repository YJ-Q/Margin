<!-- benchmark-case: case-06 | session-id: 01a07490-65fb-7643-9a8e-d1d7d69643be | workspace-repo: <repo> -->
# Margin Smart Handoff

源 checkpoint：2026-09-07T02:50:32.344Z；Repo Truth：2026-09-07T02:50:32.611Z。
Confirmed = 句子描述的事实。Inferred = 解释/意图。Uncertain = 未能确认，不代表失败。

## 目标（历史请求，接手前请确认是否更新）

- **Inferred** 你现在负责实现 Margin：

# Slice 2.6 — Terminal Handoff Action Hierarchy Fix

本 Slice 已完成 R1 research。

本轮只有一个目标：

> **正确恢复 terminal assistant handoff 中的顶层 Historical Intended Action，避免同一 claim 内较早出现的实现子步骤抢占顶层 handoff commitment。**

这是一个 parser/distiller correctness fix。

不要实现 Current Repo reconciliation。

---

# 1. 已确认的根因

当前 Distiller 能从 ordered `Assistant claim` 中恢复 explicit intended action。

但是同一条 terminal claim 可能包含：

```text
Proposed Slice 2.3

- Add a bounded helper...
- Filter internal sessions...
- Add focused tests...

Implementation handoff

Implement Slice 2.3 using Option B.
```

当前 selector：

1. 将 claim 按句子/换行拆分；
2. 找符合 `ACTION_START` 的候选；
3. 对单条 claim 使用类似 `.find(Boolean)` 的 first-match 逻辑。

因此首先命中：

`Add a bounded, fail-open helper...`

而错过后面层级更高的：

`Implement Slice 2.3 using Option B`

这是一个已确认的 correctness bug。

---

# 2. 当前产品语义

本 Slice 中：

`nextStep`

继续只表示：

## Historical Intended Action

也就是：

> Old Session 结束时，assistant 明确留下的 intended next action。

它**不是**：

`Current Executable Action`

因为现有 Repo Truth 只能支持：

- Level 0：historical intent
- Level 1：repo-target relationship

目前不支持：

- task completed
- stale action
- superseded action
- current executable action

因此本 Slice 不改变 nextStep 的总体语义。

---

# 3. Desired outcome

对于真实 frozen Session：

错误：

```text
Add a bounded, fail-open helper that reads only the first session_meta...
```

正确：

```text
Implement Slice 2.3 using Option B
```

并保持：

- confidence = `Inferred`
- provenance = originating terminal Assistant claim
- 无明确 terminal action 时保留现有 generic fallback

---

# 4. Implementation principle

不要简单把：

`.find(...)`

改成：

`.findLast(...)`

然后结束。

因为“最后一句 action phrase”不一定永远等于顶层 handoff。

需要先检查当前真实 terminal claim 的结构和现有测试模式，然后做：

**smallest deterministic hierarchy-aware correction**

优先利用已经存在的结构信号，例如：

- `Implementation handoff`
- `Next step`
- `Recommended implementation`
- terminal conclusion / handoff section

但不要建立通用 Markdown parser 或 NLP classifier。

目标只是解决已经观察到的 terminal-handoff hierarchy failure。

---

# 5. Selection semantics

需要保持两个层级：

## Cross-claim recency

仍然：

> 较新的明确 terminal commitment 可以 supersede 较早 claim。

现有 Slice 2.4 行为不要破坏。

例如：

```text
Earlier claim:
Implement A.

Later claim:
Do not implement A yet. Research B first.
```

仍应恢复：

`Research B first`

---

## Within-claim hierarchy

新增正确行为：

如果同一个 terminal assistant claim 中存在：

```text
Earlier body/substeps:
Add helper...
Modify file...
Run tests...

Later explicit handoff:
Implement Slice 2.3 using Option B.
```

应该优先恢复：

**明确 terminal handoff 中的顶层 action**

而不是 body 中首先匹配关键词的子步骤。

---

# 6. Do not over-generalize

不要把所有带以下单词的最后一句都当作顶层：

- Implement
- Add
- Modify
- Research
- Run

也不要通过纯位置规则：

`最后一个 action candidate = 正确答案`

来替代层级判断。

优先识别：

> explicit handoff / next-action context

只有在没有这种更强结构信号时，才沿用已有 fallback candidate behavior。

---

# 7. Current Repo Truth boundary

Slice 2.5 已经支持：

```text
historical structured edit
→ target provenance
→ current repo observation
```

但当前证据最多支持 Repo-target relationship。

本 Slice不要根据以下事实修改 nextStep：

```text
target exists
hash matches
added lines present
test passed
dirty worktree
```

因为它们不能证明：

`Historical action is currently executable or completed`

---

# 8. Frozen negative case

继续使用真实 Slice 2.3 research Session-shaped fixture。

它应该恢复：

```text
Historical intended action:
Implement Slice 2.3 using Option B
```

同时：

```text
targetLinkage.status = unknown
```

如果相关 state 同时出现在测试中。

不得因为当前真实 Repo 已经包含该实现而输出：

- completed
- applied
- stale
- superseded
- already implemented

---

# 9. Structured-target positive case

如果现有测试方便，保留/补充一个最小 case：

```text
explicit historical action
+
structured operation.edit
+
current file observation
```

它只需要证明：

- Historical intent 正确恢复；
- operation → target → current observation provenance 不受影响。

不得把两者合并成：

`action complete`

不要因此扩大测试范围。

---

# 10. Acceptance tests

至少覆盖：

## Case A — same claim, substeps before terminal handoff

Input：

```text
Proposed implementation:

Add bounded helper.
Modify session filtering.
Run focused tests.

Implementation handoff:

Implement Slice 2.3 using Option B.
```

Expected：

`Implement Slice 2.3 using Option B`

不是：

`Add bounded helper`

---

## Case B — latest claim supersedes earlier claim

Input：

```text
Claim 1:
Implement A.

Claim 2:
Research B first before implementing A.
```

Expected：

恢复 Claim 2 的明确当前 action。

保持 Slice 2.4 的 cross-claim recency 行为。

---

## Case C — explicit handoff absent

只有一般 action-like commentary，例如：

```text
I’ll inspect X.
Add Y might help.
Tests passed.
```

如果这些不满足当前 terminal commitment 标准：

继续使用现有安全 fallback。

不要为了覆盖更多语言扩大 classifier。

---

## Case D — terminal handoff with multiple implementation substeps

确保顶层 handoff commitment 不因为内部 bullet/list 中多个：

`Add / Modify / Run`

而被降级成任一具体子步骤。

---

## Case E — confidence / provenance

Recovered historical intent：

- confidence = `Inferred`
- provenance 仍指向正确的 terminal Assistant claim

不要新建 provenance system。

---

# 11. Files expected to change

优先：

```text
src/core/handoff/distiller.js
test/handoff.test.js
```

如果现有 helper 测试位于其他 focused test 文件，可以做最小修改。

不要默认修改：

```text
repo-truth.js
evidence.js
smartSelect.js
handoff.js
web/*
continues/*
```

---

# 12. No-gos

本 Slice 不处理：

- Current applicability
- stale detection
- completion detection
- historical action ↔ structured edit semantic linkage
- action → edit → test graph
- Progress / Slice completion
- Known limitations
- Repo Truth dirty-file enumeration
- wrapper normalization
- exec parser gap
- UI
- Detailed / Deep
- Workspace
- Token / cost telemetry
- CCAM / Vibe Usage integration
- contractVersion 1.0/1.1 unrelated failures

不要顺手处理。

---

# 13. Focused validation

运行与 Slice 2.6 直接相关的测试。

至少：

```text
test/handoff.test.js
```

如果修改影响 Smart passthrough：

再运行：

```text
test/smartSelect.test.js
```

不要默认跑全仓。

之前全仓已有两个无关：

`contractVersion 1.0 vs 1.1`

失败。

不要在本 Slice 修。

---

# 14. Real regression

使用之前失败的 frozen Session / Session-shaped fixture重新生成 Handoff。

确认：

Before：

```text
Add a bounded, fail-open helper...
```

After：

```text
Implement Slice 2.3 using Option B
```

同时确认系统仍然没有声称：

```text
This is the current executable action
```

或：

```text
Slice 2.3 is incomplete
```

它只是正确恢复：

**Historical Intended Action**

---

# 15. Stop / escalation condition

如果问题可以在当前 Distiller action selector 内通过小型 deterministic hierarchy logic 修复：

直接完成。

如果发现必须：

- 建通用 Markdown AST
- 建 NLP intent classifier
- 重构 Assistant claim schema
- 改 Development-State 大结构
- 同时实现 Repo reconciliation

立即停止并报告 blocker。

不要扩大 Slice。

---

# 16. Completion report

完成后严格按：

## 1. Implementation

具体怎样修复 same-claim hierarchy。

## 2. Selection semantics

说明：

- within-claim hierarchy
- cross-claim recency
- fallback

## 3. Files changed

列实际文件。

## 4. Tests

列测试和结果。

## 5. Frozen regression

明确：

Before → After

## 6. Confidence / provenance

确认仍为：

`Inferred + originating claim evidence`

## 7. Scope check

确认没有实现：

- applicability
- completion
- stale/superseded detection
- Repo reconciliation
- UI / Detailed / Deep

## 8. Deviations / blockers

没有则：

`None`

完成后停止。

不要自行开始下一 Slice。


## 当前状态

- **Confirmed** 当前仓库 <repo>；branch=main；HEAD=a247e75ab9e78cce7853e3f281b85459a4f25e7c；58 个已跟踪修改/未跟踪文件。

## Progress

- **Uncertain · Historical** Historical validation: unknown; no direct test result was recovered from the frozen Session.

- **Uncertain · Current** Current validation: unknown; historical tests have not been rerun against the current repository observation.

## Open Issues

- **Uncertain** 8 个内部操作在捕获证据中没有明确终态（含空补丁返回、裁剪）；这不是当前阻塞清单。已存在文件只能证明当前存在，不能倒推历史命令成功。

## 测试

- **Uncertain** 冻结 Session 未识别到直接测试执行/结果，不能声称测试已通过。

## Historical Intent

- **Inferred** Implementation

## Current Applicability

- **Unknown** No structured repo targets are available for reconciliation.

## Evidence Pointers

- 快照：C:\Temp\margin-recovery-handoff-staging-20260907\06\session-01a07490-65fb-7643-9a8e-d1d7d69643be.jsonl
- SHA-256：6e18dec92f65d5c36c0cc0cbbcf090688059e98ff34791907a34ea14e2cdd690
- Workspace：<repo>
- call:L<n>/op<m> 指向 evidence 的 operations；file:* / repo:git 指向 repo-truth。
- 接手时读证据而非直接执行历史代码片段。
