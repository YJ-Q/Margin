# Margin Phase 0：continues 技术基线

结论：**真实 Codex Session → continues → Unified Context → standard Handoff 已跑通；continues 可作为发现与基础解析依赖，但 4.1.1 的 Codex Context 还不能作为完整、无损的开发状态数据层。** 当前 Codex Desktop 的 `exec` 工具封装在解析阶段就丢失了修改与结果语义，单纯扩大 verbosity 无法补回。

本实验独立于现有 Margin 持久化 Core、Pi runtime 和 Web Workbench。未调整根目录依赖、业务代码、数据库或上游代码，未实现 Distiller，未启动其他 Agent。

## 样本与产物

- 默认 `%USERPROFILE%\.codex` 发现 3 条真实 Session：论文修改、代理咨询、当前 Margin 开发任务。
- 选择当前 Margin Session `01a070e6-3bd9-7591-aa4e-31b364badda1` 的真实开发 checkpoint。它包含读取项目、Git 检查、克隆/安装及失败记录、实际文件补丁；不把非开发的历史对话当开发样本。
- 捕获原始记录到 `2026-09-05T09:41:27.683Z`；副本 SHA-256 为 `7ffd11ab9ccdd1ce5b07d2202540e4cc56893f33ac95fcbc47f833ac4d187abc`。原 Session 仍在追加，本实验默认重跑复用副本。
- **限制：这是当前未结束任务的自取样，只有 7 条上游认可的对话消息；不是独立、完整、多轮历史开发样本。无法据此验证长会话语义召回或跨 Agent 续接质量。**
- 没有原生 `archived_sessions` 目录。真实 active 数据已验证；归档使用同一真实 JSONL 的隔离副本验证路径扫描、提取及 active/archive ID 去重，没有操作原 Session 的归档状态。

要求的三个文件均位于 `output/`：

| 文件 | 内容 |
| --- | --- |
| [baseline-session-info.md](output/baseline-session-info.md) | Session 元信息、大小、计数、源位置、保真限制 |
| [baseline-continues-handoff.md](output/baseline-continues-handoff.md) | `extractContext(session).markdown` 原样输出 |
| [baseline-context.json](output/baseline-context.json) | 提高配置上限的原生 Context，加明确分隔的逐行证据层 |

辅助证据包括 `capture.json`、`discovery.json`、`continues-standard-context.json`、`measurements.json`、`verification.json` 和冻结 JSONL。原始会话及全部输出通过实验目录 `.gitignore` 保持本地，不自动进入提交；源码、锁文件与这份结论可独立审查。

## 依赖与 Public API

研究上游 [yigitkonur/cli-continues](https://github.com/yigitkonur/cli-continues)，固定源码提交 `e486cd22a592d89d890cff056624647fbe9cbe80`，本地只读副本在 `.runtime/phase0-continues/upstream/`。实际运行的是 npm 发布包 **continues 4.1.1**，不是把源码内部文件直接导入项目。发布包完整性记录在实验锁文件与 Context；源码提交和 npm 包是两个单独记录的来源，不宣称 npm 发布包含该提交的全部代码。MIT；Node >=22.5；ESM import，根入口与 CLI 分开。

实际使用：

```js
import { adapters, extractContext, generateHandoffMarkdown } from 'continues';

const sessions = await adapters.codex.parseSessions();
const session = sessions.find(s => s.id === selectedId);
const standard = await extractContext(session); // 不传配置：内置 standard
const expanded = await extractContext(session, completeConfig);
// generateHandoffMarkdown 用于验证独立公共渲染器与 standard.markdown 一致
```

- `adapters.codex.parseSessions({ cwd?, limit?, lightweight? })`：公开 registry 中的 adapter 方法，无需写用户索引缓存、扫描其他 Agent 或启动 CLI。
- `extractContext(session, config?)`：公开 dispatcher，按 `source` 调 adapter。返回 `SessionContext`，含 `session / recentMessages / toolSummaries / filesModified / pendingTasks / sessionNotes / timeline / markdown`。
- `generateHandoffMarkdown(...)`：公开纯渲染入口。验证时按原字段传入，生成字符串与默认 extraction 一致。
- `getAllSessions / getSessionsBySource / findSession / buildIndex` 也导出，但索引路径会写 `~/.continues/`；本次不需要，未调用。
- `UnifiedSession`、`SessionContext`、`ConversationMessage`、`ToolUsageSummary`、`SessionNotes` 等类型从包根导出。`UnifiedSession` 的时间在运行时是 `Date`，JSON 重载后必须恢复。
- `getPreset`、`mergeConfig`、`VerbosityConfig` 没有从包根导出，`continues/config` 实测报 `ERR_PACKAGE_PATH_NOT_EXPORTED`。实验通过公开 extraction 参数传完整结构配置，不依赖绕过 exports 的深层导入；TS 消费者可从函数参数类型推导配置。

源码依据：[Public API](https://github.com/yigitkonur/cli-continues/blob/e486cd22a592d89d890cff056624647fbe9cbe80/src/index.ts)、[Codex parser](https://github.com/yigitkonur/cli-continues/blob/e486cd22a592d89d890cff056624647fbe9cbe80/src/parsers/codex.ts)、[统一类型](https://github.com/yigitkonur/cli-continues/blob/e486cd22a592d89d890cff056624647fbe9cbe80/src/types/index.ts)。公开 registry → 专属 parser → SummaryCollector → 公共 Markdown 是最小调用链。

## 实际得到的 Context

| 数据 | continues 原生输出 | 原始证据补充 |
| --- | --- | --- |
| Metadata | ID、cwd、repo、main、完整 Git SHA、created/updated、原位置；来源 Codex Desktop 0.153.4 | 完整 session_meta、snapshot SHA-256、原始路径与捕获时刻 |
| Conversation | 7 条：2 user、5 assistant；standard 与提高上限相同，内容在 JSON 中不裁剪 | 12 条 message 记录含 5 条 developer；原文与行号保留 |
| Tool activity | 25 次调用计数、8 个样本；其中 22 次 exec 只取最早 5 个摘要 | 全部 25 个输入、24 个返回、call_id→结果行号；行 190 尚未返回 |
| Files modified | `[]` | 行 65/115/151/159/183 的嵌套补丁及返回指针保留，不把尝试自动判为成功 |
| Pending tasks | `[]`，Codex parser 没实现任务提取 | 原始需求、当前状态、未返回调用均可回溯；不自动推导任务 |
| Model / usage | gpt-6-astra、最后 token_count 累计 input/output/cache/reasoning token 数 | 1 个 turn_context、24 个 token_count、25 个 token_usage_record 全量保留 |
| Reasoning / compaction | 无 reasoning 高亮，无 compactSummary | 18 条 reasoning 只索引位置/大小，不解密内容；原样本无 compacted 记录 |
| Timeline | 7 条消息 + 1 条 task_started | 191 条按 JSONL 行序的证据记录，保留时间、原始类型与 ordinal |
| Fidelity | 未自动生成告警 | `phase0Evidence.fidelityWarnings` 显式记录已知缺口 |

`phase0Evidence` 是本实验附加字段，不能归功于 continues；它只保存原始事件与索引，不对封装的 JavaScript 执行、重新解释为 shell、推断任务或生成语义摘要。下阶段可消费原生字段，也可通过 `indices.toolPairs` 等索引按需读取原始证据。结构化工具“摘要”不等于完整调用日志，文件列表也不等于 Git diff。

## standard 保留、遗漏与开销

保留有效状态：项目路径、来源、分支与 SHA、模型、当前可见进展、用户目标开头、原始证据访问位置。最后一条 assistant 消息确实保留，本样本没有发生“尾部最新消息被平衡窗口丢弃”。

主要遗漏及证据（行号均指冻结 JSONL，可从 `phase0Evidence.records` 查询）：

1. **执行结果与改动事实缺失。** 行 65 新建实验 package.json/.gitignore，115 新建脚本，151/159/183 更新脚本；对应结果行 69/118/155/163/186。上游把 custom `exec` 当普通工具，仅保存最早 5 次、每次约 80 字符摘要。首个补丁在第 8 次 exec，连摘要也进不了输出。`filesModified=[]`，看不出已经建立可复用实验脚本。扩大所有可配置采样上限后仍只有 8 个样本：损失发生在 parser/collector，不是 Markdown 变短才发生。
2. **约束裁剪。** 行 9 的真实需求为 1,293 字符，Recent Conversation 只展示前 500 字符；原项目保护、禁止扩范围和定向测试等后半段要求没有呈现。JSON 中仍保留完整内容，应从 JSON 取输入，不能再从 standard Markdown 逆向恢复。
3. **空待办具有歧义。** parser 固定初始化空 pendingTasks，未提取需求或 plan；捕获时行 190 的基线命令尚未返回，Handoff 没有表示这个边界。未返回不等于失败，更不等于已完成。
4. **活动时间不准确。** 1,284,244 字节的 Session 超过 1 MiB，Discovery `lines=0`、updatedAt 使用 mtime（09:30:04.377Z），而最后记录在 09:41:27.683Z。它们分别是未知行数占位与文件时间，不应作为精确消息数/末次工作时间。
5. **Token 元数据滞后一条。** 最后 token_count 是 1,820,384 in / 9,229 out；行 191 更新的 token_usage_record.thread_token_usage 是 1,921,482 in / 9,644 out。上游忽略此新记录类型。这是原 Session 累计 usage，不能当作 Handoff 长度或本轮计费结论。
6. **消息来源语义不足。** 行 6 的插件清单被识别为 user 消息；Current State 只取最后一条 assistant，不区分 commentary 和 final。因此进展叙述不应当作已验收的结果。

标准 Handoff 共 **4,801 个 JavaScript 字符、6,327 UTF-8 字节**，未测精确 Token。Tool Activity 为 1,013 字符，约占 21.1%，主要是早期读取、克隆代码片段及 wait 调用；保留的插件清单正文约 500 字符，占 10.4%。最后的 185 字符进展在 Current State 和 Recent Conversation 重复。这些文本比成功修改、失败原因、下一步证据的续接价值低。

## recentMessages / samples / truncation 的适用边界

- 本版源码 standard 为 `recentMessages=10`、`maxMessageChars=500`、shell samples=8、read=20、edit/write=5、timelineWindow=20、finalAnswerChars=4000。README 的简表不能代替实际配置。
- `full` 仍默认 50 条消息、999 个样本，不是无损模式。实验显式提高完整配置；本样本不足 10 条可见对话，因此消息数相同，不夸大为已经实测长历史窗口损失。
- Codex 平衡尾窗在末尾全是 assistant 时，会从最后一条 user 起取 N 条，可能丢掉更晚的实际完成消息；时间线又按事件数切片，生命周期多时可能挤掉用户要求。这里是源码可见风险，本样本未触发。
- `SummaryCollector` 取每类**最早**若干条，不按信息价值、成功失败、最近时间选；未知类别回落硬编码 5，因此增加 shell/MCP 上限不能改善 custom exec。
- Codex parser 还有 MCP 参数/结果 100 字符、shell stdout 5 行、compaction 500 字符、前 5 条 reasoning 首句等硬编码。原样本没有 compaction 或传统直接 shell call，未将这些源码限制宣称为本样本实测损失。
- parser 存在 response_item 时整体偏好该消息源，不逐条合并 event_msg；timeline 没有把工具事件接入。扩大配置不会改变这两点。

依据：[verbosity 配置](https://github.com/yigitkonur/cli-continues/blob/e486cd22a592d89d890cff056624647fbe9cbe80/src/config/verbosity.ts)、[采样器](https://github.com/yigitkonur/cli-continues/blob/e486cd22a592d89d890cff056624647fbe9cbe80/src/utils/tool-summarizer.ts)、[Markdown renderer](https://github.com/yigitkonur/cli-continues/blob/e486cd22a592d89d890cff056624647fbe9cbe80/src/utils/markdown.ts)。

## Margin 可直接使用什么

可直接复用 Session 身份、来源路径、记录的 cwd/branch/SHA、完整消息文本、模型元数据与原始证据引用。Date 序列化、路径和来源可信度须由调用方处理；实测 `cwd: 'D:\\Code\\margin'` 返回 1 条，而等价的 `'D:/Code/margin'` 返回 0 条。可无过滤发现后规范化路径匹配，不必重写上游。

需要重新计算或语义提取的是：成功的文件修改与最终状态、待办、测试结果、确定的决策/失败方案、当前真正目标和唯一下一步。尤其不能把 `[]` 当作“没有待办/修改”，也不能把最新 assistant 文本直接当事实。

需要结合当前 Git/Workspace 做二次校验。Session 的 SHA 是历史坐标，不能证明当前文件与当时相同；本实验将当前 Git 状态与 Session 元数据分开保存，并校验所有预先未提交文件的 SHA-256。后续接手时也应按相关文件验证，不能因此扩展成全仓审核。

**下一步唯一最值得验证的问题：在保留 `exec` 调用—结果证据的前提下，能否用 1K–3K Token 准确表达“已经完成什么、尚未完成什么”，让接手者不重复已成功的修改？** 先验证这个开发 checkpoint 的保真度。当前数据表明，从已被采样的 standard Context 继续压缩无法解决源头遗漏；本轮仅记录必要的上游兼容缺口，没有实现修复或 Distiller。

## 运行与验证

从仓库根目录：

```powershell
npm.cmd ci --prefix experiments/phase0-continues --ignore-scripts --no-audit --no-fund
.\.runtime\node-v22.23.1-win-x64\node.exe experiments/phase0-continues/run-baseline.mjs --discover
.\.runtime\node-v22.23.1-win-x64\node.exe experiments/phase0-continues/run-baseline.mjs
.\.runtime\node-v22.23.1-win-x64\node.exe experiments/phase0-continues/verify-baseline.mjs
```

初次生成使用 Node 24.20.0，最终生成与定向验证使用项目已有 Node 22.23.1。传 `--session=<完整 ID>` 可选择另一条已发现 Session；默认使用本次 ID，找不到则报错，不静默换样本。已有副本默认复用；`--refresh` 明确重新捕获。新机器需有该真实源文件或选择自己的样本，测试不会虚构 Session。

15 项定向断言通过，包含哈希/源前缀、原样 Markdown、公开 renderer 一致性、原始证据覆盖、call_id 配对、已有修改完整保留、真实数据副本归档提取与去重、配置 export 边界。Windows cwd 差异作为缺陷观测记录，不伪装成已修复。没有运行 Margin 全套测试、UI 构建、发布检查或上游全套测试。

## Git 与本次文件范围

开始和结束分支都是 `main`，HEAD 都是 `0836e800a4bf386e58ec1e9c02be5b7279497c9f`。起始状态与 23 个原有未提交文件哈希见 `git-before.json`。原有 5 个已跟踪文件修改和原有未跟踪文件均逐字节保留；没有 commit/stage/reset。

新增的可跟踪文件仅本目录的 `.gitignore`、`package.json`、`package-lock.json`、`git-before.json`、`run-baseline.mjs`、`verify-baseline.mjs`、`README.md`。新增本地生成数据位于 `output/`（含三个要求的基线产物），实验依赖位于本目录 `node_modules/`；上游只读副本在根 `.runtime/phase0-continues/upstream/`。后三者均被忽略。根项目 package.json/package-lock.json 和所有现有代码的修改都来自本轮开始之前。
