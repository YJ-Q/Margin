<!-- benchmark-case: case-07 | session-id: 01a074d4-f3b2-76e1-8411-9f93be0a91a2 | workspace-repo: <repo> -->
# Margin Smart Handoff

源 checkpoint：2026-09-07T09:27:28.093Z；Repo Truth：2026-09-07T09:27:28.397Z。
Confirmed = 句子描述的事实。Inferred = 解释/意图。Uncertain = 未能确认，不代表失败。

## 目标（历史请求，接手前请确认是否更新）

- **Inferred** 你现在负责实现 Margin：

# Slice 3.2 — Resume-first Checkpoint Experience

本 Slice 已完成 R1。

Phase 3 当前状态：

```text
R0            ✅ Workspace V1 blueprint
Slice 3.1     ✅ Workspace-aware Recent Sessions
                 Time-to-identify ≤10s

Slice 3.2     → Resume-first Checkpoint Experience
```

本 Slice 的产品目标：

> 用户已经找到正确 Session 后，不需要阅读完整 Handoff，也能快速判断接手风险，并在 ≤2 次主交互内取得可粘贴到另一个 Coding Agent 的 checkpoint。

当前真实流程已经是：

```text
Select Session
→ automatic fresh generation
→ full Markdown preview
→ Copy
```

因此本 Slice **不要增加 Resume 按钮或额外交互**。

真正要改变的是：

```text
Full Markdown first
```

变成：

```text
Resume Summary first
→ Copy checkpoint
→ Full checkpoint on demand
```

---

# 1. Scope

只实现：

## A. Minimal structured Resume Summary API projection

Core 已经生成：

```js
{
  evidence,
  truth,
  state,
  markdown
}
```

HTTP 当前只返回：

```js
{
  session,
  markdown
}
```

扩展为：

```js
{
  session,
  markdown,
  resumeSummary
}
```

`resumeSummary` 只能是已有 semantic state 的 browser-safe projection。

不要创建新的 inference engine。

---

## B. Resume-first SessionDetail

Select 后仍自动 fresh-generate。

生成成功后 above-the-fold 显示：

- Goal
- Progress
- Current Applicability
- Current Validation
- `Copy checkpoint`

完整 Markdown 默认收起，通过：

`View full checkpoint`

展开。

---

## C. Copy primary / Save secondary

Primary：

`Copy checkpoint`

Secondary：

`Save to workspace`

不要增加 native Resume / launcher / agent integration。

---

# 2. Preserve current interaction model

当前已经满足：

```text
1. Select
2. Copy
```

不要改成：

```text
Select
→ Resume button
→ Copy
```

也不要：

```text
Select
→ automatically copy
```

前者增加无价值 interaction。

后者缺少用户控制，也会让 unknown applicability 等安全信息失去意义。

---

# 3. Fresh generation stays

每次选择一个新的 Session：

继续：

```text
fresh generate
```

生成：

- historical Session evidence
- current Repo Truth
- current Development State
- markdown
- resumeSummary

不要增加：

- cache
- checkpoint status
- Ready / stale
- generatedAt lifecycle

切换 Session 后现有 effect cancellation / reset behavior必须保留。

---

# 4. Resume Summary is a projection, not a new model

新增一个很小的：

```text
projectResumeSummary(state, truth?)
```

或符合现有 module boundary 的 equivalent helper。

职责只有：

> 把已经存在的 Distilled State 映射成 UI 所需的小 DTO。

禁止在这个 helper 中：

- NLP inference
- completion inference
-重新扫描 raw evidence
-重新解析 assistant messages
-重新判断 operation semantics
-重新推断 current applicability
-重新判断 validation truth

所有事实必须来自现有 `state` / 已有 structured outputs。

---

# 5. Minimal DTO

R1 推荐概念：

```js
resumeSummary: {
  goal,
  progress,
  currentApplicability,
  currentValidation
}
```

实现前先核对现有 `state` 的真实 shape。

不要为了匹配下面示例而复制数据模型。

---

# 6. Goal projection

Goal 必须继续保持 Phase 2 的语义边界。

UI 应让用户理解：

> 这是 Old Session 的工作目标，不代表当前 Repo 一定仍需要执行。

不要把 Goal UI 写成：

`Current task`

推荐类似：

### Goal

然后小型辅助语义：

`From the selected session`

或现有视觉语言下等价表达。

如果 Goal confidence 已存在：

可以使用现有 confidence 信息。

但不要让 UI 充满：

`Confirmed / Inferred`

除非它确实改变用户判断。

目标是产品可读性，不是 evidence dashboard。

---

# 7. Progress projection

这是本 Slice 最需要控制的信息密度。

当前 `state.progress` 可能包含：

- assistant-reported milestone
- historical validation
- structured work evidence
- current corroboration
- current validation

一级 Resume Summary 不能 dump 全部 progress。

要求：

### 最多展示 2–3 个最有决策价值的 progress facts。

优先顺序建议：

1. terminal assistant-reported milestone
2. meaningful historical validation
3. meaningful structured work/corroboration

但必须基于现有 milestone type/basis，而不是重新做 NLP。

如果 progress 多于展示上限：

不要丢掉完整信息。

完整内容仍存在于 expanded checkpoint Markdown。

不要新增复杂 scoring framework。

一个小 deterministic selection 就够。

---

# 8. Progress wording

必须保留 temporal / confidence meaning。

例如：

```text
Assistant reported: Phase 1 Distiller PoC complete
```

不能简化成：

```text
Phase 1 Distiller PoC complete
```

历史测试：

```text
5 focused test commands passed historically
```

不能写：

```text
5 tests pass
```

current corroboration：

```text
13 historical targets are currently observable
```

不能写：

```text
Implementation verified
```

---

# 9. Current Applicability

这是 Resume Summary 的核心安全字段。

使用已有 Slice 2.7 state。

概念展示：

### Current applicability

如果有 structured reconciliation：

显示现有 conservative text。

如果 Unknown：

使用低摩擦信息提示，例如：

```text
Check first
Historical intent has no structured repo target for reconciliation.
```

或与当前 state wording一致的更短表达。

原则：

- informational
- visible
- non-blocking

不要使用：

- modal confirmation
- danger dialog
- disabled Copy

Unknown 是正常证据边界，不是 error。

---

# 10. Do not invent checkpoint status

不要把：

`Current Applicability = Unknown`

重新命名成：

`Checkpoint not ready`

它们不是同一个概念。

当前仍然没有 checkpoint lifecycle evidence。

不要出现：

- Ready
- Needs refresh
- Stale
- Not generated

---

# 11. Current Validation

Resume Summary 要明确：

> 当前 workspace 是否重新验证过？

在当前 V1，大部分情况下是：

```text
Validation not rerun
```

这是正确结果。

不要把 historical exit 0 提升成 current validation。

如果现有 state 能表达更具体情况，投影已有事实即可。

禁止新建 test rerun detection。

---

# 12. Historical Intent

Historical Intent：

**不要进入 above-the-fold Resume Summary。**

原因：

虽然它是重要 provenance，但它最容易再次被误解为：

`Next Action`

保持在：

`View full checkpoint`

展开后的完整 Markdown。

不要删除或改写现有 Historical Intent section。

---

# 13. Above-the-fold information hierarchy

生成成功后页面结构建议：

```text
<Session label>
<Workspace · Agent · Branch · time>

Continue in another coding agent
Fresh portable checkpoint prepared from this session + current workspace.

Goal
...

Progress
...

Current applicability
...

Current validation
...

[ Copy checkpoint ]

View full checkpoint
Save to workspace
```

具体 markup / spacing 跟随现有 Margin UI。

不要做高保真 redesign。

---

# 14. Product terminology

Primary button：

# `Copy checkpoint`

不要使用：

- Resume
- Resume session
- Generate Handoff
- Continue automatically

因为当前 Margin不会：

- restore native Codex session
- launch Claude
- create new agent
- auto-attach context

页面/section 标题可以表达：

`Continue in another coding agent`

但必须保留 portable checkpoint 边界。

---

# 15. Boundary copy

在 Resume area 提供一句非常短的说明。

概念：

> A fresh portable checkpoint from this session and the current workspace.

不要写长教程。

不要让用户误以为：

- Margin 会持续同步这个 checkpoint
- Margin 会自动启动目标 Agent
- 保存文件之后永远 fresh

---

# 16. Full checkpoint

当前完整 Markdown：

继续使用同一份：

`markdown`

不要重新生成。

默认：

**collapsed**

入口：

`View full checkpoint`

展开后显示当前完整 Smart Development Checkpoint。

用户可以：

- 审阅 Historical Intent
- 看 evidence pointers
- 看完整 Repo Truth
- 看完整 validation/history

收起后不要销毁生成结果。

---

# 17. Copy behavior

`Copy checkpoint`

继续复制：

**完整 Markdown**

不是只复制 Resume Summary。

Resume Summary 是给用户做接续判断的。

真正送给新 Agent 的仍然是 Phase 2 已验证的完整 portable checkpoint。

这一点不要改变。

---

# 18. Copy feedback

检查并保留/增强最小反馈：

成功：

```text
Copied
```

失败：

明确显示：

```text
Couldn’t copy checkpoint
```

允许重试。

不要做 toast framework 重构。

使用当前组件最小机制。

---

# 19. Save behavior

`Save to workspace`

仍然保存：

```text
<workspace>/.margin/HANDOFF.md
```

使用与 Copy 相同的当前 generation result。

不要重新 generate。

Save 是 secondary。

成功文案必须避免：

`Checkpoint ready`

这会暗示 lifecycle。

更准确类似：

```text
Saved current checkpoint to .margin/HANDOFF.md
```

可以有一个简短提醒：

> It will not update automatically as the session or repo changes.

不要做 modal。

---

# 20. Loading state

Select 后自动 fresh generate 时：

页面应表达：

```text
Preparing fresh checkpoint…
```

而不是：

`Loading saved checkpoint`

Generation 未完成前：

- Copy disabled / unavailable
- Save disabled / unavailable

保持当前 error-safe behavior。

---

# 21. Generation failure

如果 generate API 失败：

必须清楚显示 failure。

至少提供：

`Retry`

Retry：

只重新执行当前 selected Session 的 generate。

不要要求用户重新点击 Session。

不要建立 retry framework。

---

# 22. HTTP projection

在：

`POST /api/handoff/generate`

返回最小：

```js
{
  session,
  markdown,
  resumeSummary
}
```

不要暴露：

- evidence
- full truth
- operation graph
- source path
- originalPath
- native transcript
- raw assistant claims
- internal control metadata

这是真正的：

**browser-safe semantic projection**

---

# 23. Projection ownership

推荐：

Core / handoff layer：

负责从已有 state 构造 resumeSummary。

HTTP：

负责序列化。

Client：

只消费。

React：

只展示。

不要在 React 中从 Markdown 提取 Goal/Progress。

不要在 API client 中重新解释 state。

---

# 24. Do not duplicate renderer logic

当前 Markdown renderer 已经负责完整 checkpoint。

ResumeSummary projection 和 Markdown renderer可以消费同一个 Distilled State。

但不要：

```text
render markdown
→ parse markdown
→ build summary
```

也不要复制整套：

Historical Intent / Current Applicability inference。

---

# 25. Progress size guard

因为 implementation-heavy Sample B 已经产生 248 行 checkpoint，一级 Progress 必须有 deterministic upper bound。

例如：

```text
max 3 items
```

确切数量根据现有 UI选择。

测试必须覆盖：

`many progress milestones`

不会导致 Resume Summary无限增长。

---

# 26. Empty / unknown states

如果某字段没有足够 evidence：

显示明确 Unknown，而不是隐藏造成假确定性。

例如：

```text
Progress
No source-backed progress available.
```

或现有产品语言等价表达。

但保持简短。

尤其：

- no progress
- applicability unknown
- validation unknown

都是 legitimate states。

---

# 27. Do not modify Phase 2 semantics

本 Slice绝对不能改变：

- Historical Intent extraction
- Current Applicability logic
- progress milestone semantics
- test historical/current distinction
- Repo Truth
- Smart selection
- task completion boundaries

本 Slice只是：

`project + present`

---

# 28. Tests — DTO projection

至少覆盖：

## A. Research-only state

ResumeSummary：

- historical Goal
- research progress / inferred report
- applicability unknown
- current validation unknown

不能出现：

`Implementation complete`

---

## B. Implementation state

ResumeSummary：

- Goal
- assistant-reported implementation milestone保留 inferred/report wording
- historical validation保留 historical wording
- current applicability from existing state
- current validation not rerun

不能显示：

`Phase completed`

---

## C. Many progress items

一级 summary deterministic 截断到上限。

完整 Markdown仍然包含完整 checkpoint。

---

## D. Missing fields

Projection 输出稳定的 Unknown/empty-safe UI shape。

不 crash。

---

# 29. Tests — HTTP

验证 generate endpoint：

以前：

```js
{ session, markdown }
```

现在：

```js
{ session, markdown, resumeSummary }
```

同时确认不返回 raw：

- evidence
- truth
- operations
- source paths

---

# 30. Tests — SessionDetail

覆盖：

### Loading

`Preparing fresh checkpoint`

### Generated

显示四个 summary sections。

### Full checkpoint

默认收起。

用户点击：

`View full checkpoint`

才看到 Markdown。

### Copy

复制的仍是完整 Markdown。

不是 Resume Summary。

### Save

保存的仍是同一份 Markdown。

### Unknown applicability

显示 informational state，Copy 不被阻止。

### Generation failure

可 Retry。

### Copy failure

有 visible feedback。

### Save failure

有 visible feedback。

---

# 31. Interaction regression

真实行为必须保持：

```text
Select
→ one automatic generate
→ Copy
```

最多：

**2 main interactions**

不要因为 accordion / details 存在而要求用户展开才能 Copy。

---

# 32. Real validation

至少使用：

## Sample A

research-only Session。

确认用户 above-the-fold 能理解：

- 这是研究 Session
- implementation 尚不是 confirmed progress
- applicability unknown
- validation unknown

无需展开 full checkpoint 即可作出安全判断。

---

## Sample B

implementation-heavy Phase 1 Session。

确认用户能理解：

- assistant reported completion
- historical tests passed
- current validation未 rerun
- current repo evidence没有被提升成 confirmed task completion

同样无需先阅读 248 行 checkpoint。

---

# 33. Time-to-resume validation

从用户已经看到正确 Session 开始。

测试：

```text
Select
→ wait for generation
→ inspect Resume Summary
→ Copy checkpoint
```

记录：

- main interaction count
- 是否 ≤2
- 是否 ≤30 秒
- 是否必须展开 full checkpoint
- 是否发生 semantic confusion

目标：

```text
≤2 main interactions
≤30 seconds
no mandatory full-checkpoint reading
```

不要伪造机器耗时。

真实记录即可。

---

# 34. Semantic safety acceptance

必须确认：

用户可见 Resume Summary 没有发生：

### Historical → Current

例如历史 test pass 显示为 current pass。

### Assistant report → fact

例如：

`assistant reported complete`

被简化成：

`complete`

### Applicability Unknown → Ready

禁止。

### Historical Intent → Next Step

一级不显示 Historical Intent。

### Current target → task completion

禁止。

---

# 35. Explicitly deferred

不要实现：

- checkpoint lifecycle/status
- Ready / Needs refresh
- native Codex/Claude resume
- launcher
- deep link
- auto-paste
- live session hooks
- active agent
- Workspace state merge
- search
- archive/delete
- usage/token/cost
- Vibe Usage
- CCAM
- new Handoff engine semantics
- rerun validation engine
- high-fidelity redesign

---

# 36. Expected files

可能涉及：

### Core

handoff state projection helper，优先放在现有 handoff module 内。

### HTTP

`httpAdapter.js`

### Web

`SessionDetail.js`
`marginApiClient.js` 如确有需要
`margin.css`

### Tests

focused Core/API/SessionDetail tests。

不要为了 DTO 建大型目录重构。

---

# 37. Validation

运行直接相关：

- projection tests
- HTTP adapter tests
- SessionDetail UI tests
- existing selection/Handoff regression
- production build
- `git diff --check`

如果直接修改共享 handoff state function，再跑对应 focused Phase 2 tests。

不要默认全仓测试。

---

# 38. Stop / escalation condition

如果实现只需要：

```text
existing state
→ minimal projection
→ HTTP
→ React presentation
```

直接完成。

如果发现必须：

- 重新设计 Distiller
- parse Markdown
- 建第二套 progress semantics
- 修改 Current Applicability
- 建 checkpoint lifecycle
- run validation automatically

停止并报告 blocker。

不要扩大 Slice 3.2。

---

# 39. Completion report

严格输出：

## 1. Resume Summary projection

实际 DTO 与来源。

## 2. Information hierarchy

above-the-fold / expanded / secondary。

## 3. Progress selection

如何保持简短并保留语义。

## 4. Product terminology

实际使用的标题、primary action、boundary wording。

## 5. HTTP change

暴露什么、不暴露什么。

## 6. Files changed

## 7. Tests

实际命令与结果。

## 8. Research-only validation

真实 UI 结果。

## 9. Implementation-session validation

真实 UI 结果。

## 10. Time-to-resume

interaction count + actual acceptance。

## 11. Semantic safety

确认没有历史/当前、report/fact 等语义越界。

## 12. Regression

Select → generate → Copy/Save 仍然工作。

## 13. Scope check

确认 deferred 项均未实现。

## 14. Deviations / blockers

无则：

`None`

完成后停止。

不要自行开始 Slice 3.3。


## 当前状态

- **Confirmed** 当前仓库 <repo>；branch=main；HEAD=a247e75ab9e78cce7853e3f281b85459a4f25e7c；340 个已跟踪修改/未跟踪文件。

## Progress

- **Inferred · Historical** Assistant-reported milestone: DTO 测试确认研究 milestone 保持 `Assistant-reported research milestone`；applicability 与 validation 均为 Unknown，不提升为 implementation complete。

- **Confirmed · Historical** Historical validation: 2 focused test commands exited 0.

- **Confirmed · Historical** Historical validation: 2 focused test commands failed.

- **Uncertain · Historical** Historical validation: 4 focused test commands had no explicit final result.

- **Uncertain · Current** Current validation: unknown; historical tests have not been rerun against the current repository observation.

## Historical Report

- **Inferred · Historical** ## 1. Resume Summary projection

- **Inferred · Historical** Terminal assistant report (excerpt): ## 1. Resume Summary projection 新增 `projectResumeSummary(state, truth)`：Goal、最多 3 条 Progress、Current applicability、Current validation，均来自既有 semantic state / repo truth。 ## 7. Tests 通过： ```text node --test test/resumeSummary.test.js test/marginSessionDetail.test.js test/marginSurfaceHttpAdapter.test.js test/handoff.test.js 53 passed ## 8. Research-only validation DTO 测试确认研究 milestone 保持 `Assistant-reported research milestone`；applicability 与 validation 均为 Unknown，不提升为 implementation complete。 ## 9. Implementation-session validation DTO 测试确认 assistant report、historical validation、未重跑 current validation 和 reconciliation 状态均保持原有语义。 ## 14. Deviations / blockers 无。

## 已完成（事实范围）

- **Confirmed** 历史命令进程已成功返回：& .\.runtime\node-v22.23.1-win-x64\node.exe --test test/resumeSummary.test.js test/marginSessionDetail.test.js test/marginSurfaceHttpAdapter.test.js test/handoff.test.js; npm ru...（exit_code=0）；不代表之后文件仍未变化。（同一事实重复出现 2 次，仅展示一次）

## 失败 / 已拒绝

- **Confirmed** 命令进程失败：npm test -- --test-name-pattern="(resumeSummary|SessionDetail|handoff/generate|research-only progress|implementation progress)"；exit_code=1

- **Confirmed** 命令进程失败：& .\.runtime\node-v22.23.1-win-x64\node.exe --test test/resumeSummary.test.js test/marginSessionDetail.test.js test/marginSurfaceHttpAdapter.test.js test/handoff.test.js；exit_code=1

## Open Issues

- **Uncertain** 14 个内部操作在捕获证据中没有明确终态（含空补丁返回、裁剪）；这不是当前阻塞清单。已存在文件只能证明当前存在，不能倒推历史命令成功。

## 测试

- **Confirmed** 测试命令 npm test -- --test-name-pattern="(resumeSummary|SessionDetail|handoff/generate|research-only progress|implementation progress)"：failed；exit_code=1。

- **Confirmed** 测试命令 & .\.runtime\node-v22.23.1-win-x64\node.exe --test test/resumeSummary.test.js test/marginSessionDetail.test.js test/marginSurfaceHttpAdapter.test.js test/handoff.test.js：failed；exit_code=1。

- **Confirmed** 测试命令 & .\.runtime\node-v22.23.1-win-x64\node.exe --test test/resumeSummary.test.js test/marginSessionDetail.test.js test/marginSurfaceHttpAdapter.test.js test/handoff.test.js; npm ru...：succeeded；exit_code=0。

- **Confirmed** 测试命令 & .\.runtime\node-v22.23.1-win-x64\node.exe --test test/resumeSummary.test.js test/marginSessionDetail.test.js test/marginSurfaceHttpAdapter.test.js test/handoff.test.js; npm ru...：succeeded；exit_code=0。

- **Uncertain** 测试命令 npm test -- --test-name-pattern="(resumeSummary|SessionDetail|handoff/generate|research-only progress|implementation progress)"：unknown；No explicit success/failure in result。

- **Uncertain** 测试命令 & .\.runtime\node-v22.23.1-win-x64\node.exe --test test/resumeSummary.test.js test/marginSessionDetail.test.js test/marginSurfaceHttpAdapter.test.js test/handoff.test.js：unknown；No explicit success/failure in result。

- **Uncertain** 测试命令 & .\.runtime\node-v22.23.1-win-x64\node.exe --test test/resumeSummary.test.js test/marginSessionDetail.test.js test/marginSurfaceHttpAdapter.test.js test/handoff.test.js; npm ru...：unknown；No explicit success/failure in result。

- **Uncertain** 测试命令 & .\.runtime\node-v22.23.1-win-x64\node.exe --test test/resumeSummary.test.js test/marginSessionDetail.test.js test/marginSurfaceHttpAdapter.test.js test/handoff.test.js; npm ru...：unknown；No explicit success/failure in result。

## Historical Intent

- **Inferred** Research-only validation

## Current Applicability

- **Unknown** No structured repo targets are available for reconciliation.

## Evidence Pointers

- 快照：<repo>\docs\validation\recovery-handoffs-r7-full\session-01a074d4-f3b2-76e1-8411-9f93be0a91a2.jsonl
- SHA-256：e708e99eb83d59f8f321b45e40a6edc0c2a9579ff221b856640fd3ae3e1ae690
- Workspace：<repo>
- call:L<n>/op<m> 指向 evidence 的 operations；file:* / repo:git 指向 repo-truth。
- 接手时读证据而非直接执行历史代码片段。
