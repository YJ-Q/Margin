# Margin｜产品方案与 Phase 0 PoC 开发计划

## 1. 产品定位

Margin 解决的是 **AI Coding Session 连续性** 问题：

> 当用户切换 Coding Agent、切换账号、额度耗尽、会话丢失或历史不可见时，用尽可能少的上下文恢复之前的开发现场，让新的 Agent 继续工作。

Margin 不追求复制完整聊天记录，而追求：

> **用更少 Token，恢复更多有效开发状态。**

---

## 2. 当前产品边界

Margin 第一阶段不做一个完整的 Coding Agent，也不负责：

- 自动打开 Claude / Codex / Pi 等 Agent
- 自动切换 IDE 或 Workspace
- 自动模型路由
- 云同步
- 用户账号体系
- 长期个人知识库
- 复杂 Dashboard
- Quota / Token 看板

第一阶段只关注：

1. 找到 Coding Agent 的历史 Session
2. 完整、可靠地读取 Session 数据
3. 提取真正影响后续开发的信息
4. 生成精简、标准化的 Handoff
5. 一键复制给任意下一个 Agent

---

## 3. 与 `continues` 的关系

调研后确认，`yigitkonur/cli-continues` 已经实现了大量底层能力：

- 多 Agent Session Discovery
- JSONL / JSON / SQLite / YAML 等 Session 解析
- Unified Session / Context
- Conversation 提取
- Tool Activity 提取
- Files Modified
- Pending Tasks
- Session Metadata
- Handoff Markdown
- Public TypeScript API

因此 Margin **不重复开发这一层**。

当前预期架构：

```text
Agent Native Sessions
        ↓
     continues
 Discovery / Parser
        ↓
  Unified Context
        ↓
  Margin Distiller
        ↓
 Compact Handoff
        ↓
       Copy
        ↓
 Any Coding Agent
```

Margin 的主要研发重点：

1. Context Distillation
2. Handoff 数据结构
3. Token 压缩
4. Continuation Quality 评测
5. 后续桌面轻量交互

如果发现 `continues` 的 Parser、Session Fidelity 或 Agent 适配存在问题，可以向上游贡献 PR，而不是在 Margin 内重复维护。

---

## 4. Margin Handoff 目标格式

第一版使用统一格式，不针对 Claude / Codex / Pi 分别设计 Prompt。

```md
# Margin Handoff

## Goal
当前真正要完成的任务。

## Current State
当前代码、功能和开发状态。

## Completed
已经完成且不应该重复执行的事项。

## Key Decisions
已经确定的重要技术决策，以及必要的原因。

## Rejected / Failed
已经验证失败、明确放弃或不应该重新尝试的方案。

## Open Issues
当前 Bug、阻塞、未知项和未完成事项。

## Changed Files
本轮真正重要的修改文件。

## Tests
已经执行的关键测试及结果。

## Next Step
下一 Agent 应该直接开始执行的下一步。

## Evidence
Workspace / Branch / Commit / Raw Session / 必要的原始资料指针。
```

设计原则：

- 不复制完整 Conversation
- 不简单依赖“最后 N 条消息”
- 不保留无意义的搜索过程和重复读取
- 优先保留会改变下一步行动的信息
- 对不确定信息保留 Evidence Pointer
- 下一个 Agent 信息不足时再按需读取原始资料
- 初步目标：默认 Handoff 控制在约 1K–3K Token

---

# 5. PoC 核心假设

我们需要验证：

> Margin Compact Handoff 是否能够以明显少于完整 Session / 重新阅读代码库的 Token 成本，让新的 Agent 正确继续开发。

需要建立四组对照：

### A. continues standard
直接使用 `continues` 当前默认 Handoff。

### B. 普通 LLM 摘要
直接让模型对 Session 做普通总结。

### C. Margin Compact Handoff
按照 Margin 的结构化策略生成精简交接。

### D. No Handoff
不给历史，让新 Agent 自己读取当前代码库和 Git 状态。

---

## 6. 后续评测指标

重点记录：

- Handoff 输入 Token
- 当前任务理解准确性
- 已完成事项召回
- 关键技术决策召回
- 未完成事项召回
- 已失败方案召回
- 是否重复已经完成的工作
- 是否重新尝试已经失败的方案
- 接手后完成任务需要的交互轮数
- 为恢复状态额外读取的代码量 / Token

最终核心问题：

> **每 1K Token 能恢复多少有效开发状态？**

---

# 7. Phase 0：技术基线验证

本阶段 **不开发完整 Margin**。

目标：

> 确认 `continues` 是否能够作为 Margin 的底层 Session 数据层，并从一条真实 Codex Session 中获取完整、可利用的结构化数据。

---

## 7.1 需要完成的任务

### Step 1｜研究 `continues`

阅读：

- Public API
- Session 数据结构
- Parser / Adapter 结构
- Context Extraction
- Markdown Handoff
- Verbosity / Truncation 机制

重点确认最小调用路径：

```text
获取 Session 列表
↓
定位真实 Codex Session
↓
提取 Unified Context
↓
获取现有 Handoff
```

---

### Step 2｜验证真实 Codex Session Discovery

使用本机真实 Codex 数据。

确认：

- Session 能否被发现
- Session ID
- Workspace / cwd
- Created / Updated
- Branch / Git SHA
- 原始 Session 文件位置
- Active 与 Archived Session 是否都能正确处理

选择一条具有真实开发过程、长度足够的 Session 作为基线样本。

---

### Step 3｜提取完整结构化 Context

尽可能保存：

- Session metadata
- Conversation
- Tool activity
- Files modified
- Pending tasks
- Model / token metadata
- Reasoning / compacted context（若原始数据存在且可合法读取）
- Timeline
- Raw session pointer
- Fidelity warnings

不要为了精简而在这一步提前丢失数据。

Phase 0 的目标是先获得尽可能可靠的 **source truth**。

---

### Step 4｜生成基线输出

至少生成：

```text
baseline-session-info.md
baseline-continues-handoff.md
baseline-context.json
```

其中：

### `baseline-session-info.md`

记录：

- 原始 Session 信息
- 文件大小
- 消息数量
- 可获得的数据类型
- 原始数据位置
- Fidelity / 缺失情况

### `baseline-continues-handoff.md`

直接保存 `continues standard` 输出。

### `baseline-context.json`

保存后续 Margin Distiller 可以消费的结构化 Context。

---

### Step 5｜分析 `continues` 当前 Handoff

回答：

1. 哪些开发状态被正确保留？
2. 哪些重要信息被遗漏？
3. 哪些内容占用了大量 Token，但对继续开发价值较低？
4. 当前 `recentMessages / tool samples / truncation` 策略可能导致哪些信息损失？
5. 哪些字段可以直接用于 Margin？
6. 哪些字段需要重新计算或语义提取？
7. 是否需要结合当前 Git / Workspace 状态进行二次校验？

---

# 8. Phase 0 明确禁止

本轮不要：

- 开发 Margin UI
- 实现桌面浮窗
- 实现新的 Distiller
- 自动调用其他 Agent
- 自动切换 IDE / Workspace
- 重构 `continues`
- 扩展大量 Agent
- 设计复杂数据库
- 做云同步
- 做 Token / Quota Dashboard
- 运行与本任务无关的全量测试
- 做无关的代码审计
- 写大规模架构方案

只有在当前改动确实需要时，才运行直接相关的测试。

---

# 9. Phase 0 完成标准

最终只需要证明：

### 1. 技术路径跑通

```text
Real Codex Session
→ continues
→ Unified Context
→ Handoff
```

### 2. 数据足够支持下一阶段

能够明确知道 Margin Distiller 的输入有哪些。

### 3. 找到当前最主要的信息损失

明确 `continues standard` 的主要不足。

### 4. 找到 Margin 下一步唯一最值得验证的问题

不要一次提出大量开发任务。

---

# 10. 当前开发 Agent 工作流

Margin 后续开发不采用：

> Codex 一直开发 → Codex 没额度 → 被迫换 Claude

默认改成：

```text
Claude
主持续开发
↓
形成清晰 checkpoint
↓
Codex
高价值分析 / Review / 难问题
↓
Margin Handoff
↓
Claude / DeepSeek / Codex
继续下一阶段
```

---

## Claude

默认主开发 Agent。

主要负责：

- 日常功能开发
- UI
- 多文件修改
- 常规 Debug
- 重构
- Targeted Tests
- 连续迭代

---

## Codex

不作为默认流水线开发 Agent。

主要用于：

- 复杂架构判断
- 陌生代码库快速理解
- 高难 Debug
- 第二工程意见
- 阶段 Review
- Phase / Merge / Release 前的重点检查
- Margin 本身的真实跨 Agent Handoff 测试

Codex 默认不要：

- 主动运行无关全量测试
- 反复审核已经确认的内容
- 自动扩大任务边界
- 修改无关文件
- 额外生成大量报告

---

## DeepSeek

作为低成本执行层。

适合：

- 明确的小功能
- 批量数据整理
- 日志分析
- Fixture / 测试数据整理
- 文档转换
- 简单代码修改
- 后续 Handoff 批量评测

---

# 11. 当前开发顺序

```text
Phase 0
Codex GPT-6 Astra
技术基线验证
↓
Phase 1
Claude
实现最小 Margin Distiller
↓
Experiment
Claude / Codex / DeepSeek
进行真实跨 Agent Handoff 对照
↓
Review
GPT-6 Astra / GPT-5.6 Sol
判断压缩策略和架构是否值得继续
↓
之后再决定
是否开发桌面浮窗 / UI
```

---

# 12. 当前最重要原则

Margin 现在不追求：

> 支持最多 Agent。

也不追求：

> 保存最多历史。

而追求：

> **在可验证的信息保真前提下，用最少上下文恢复最多有效开发状态。**

Phase 0 结束之前，不扩大产品范围。
