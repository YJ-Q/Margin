<!-- benchmark-case: case-05 | session-id: 01a07786-adf5-77a3-91ba-e4a75ceda7e7 | workspace-repo: <repo> -->
# Margin Smart Handoff

源 checkpoint：2026-09-07T08:39:04.094Z；Repo Truth：2026-09-07T08:39:04.369Z。
Confirmed = 句子描述的事实。Inferred = 解释/意图。Uncertain = 未能确认，不代表失败。

## 目标（历史请求，接手前请确认是否更新）

- **Inferred** # Margin — Token Usage Source R1

只调研，不修改代码。

## Goal

为当前 R3.3 Usage Bar 找到真实、可复用、稳定的 Token Usage 数据源。

最终只需要支持轻量信息：

- `Today total`
- 各 Agent / Provider / Model 的 usage
- unavailable 时诚实显示 `—`

不要设计 Usage Dashboard。

## Research order

按以下顺序研究：

### 1. Current local sources

检查当前机器和 repo 已有能力：

- Codex native session/log/history files
- Claude Code native session/log/task files
- 当前 `continues` 能读取的数据
- CLI/runtime 是否已经包含 token / usage / cost 字段
- 当前 Margin session normalization 是否无意中丢掉了 usage metadata

重点确认：

- 是否有 input/output token
- cached token
- reasoning token
- model/provider
- timestamp
- session association

不要从文本长度或文件 bytes 推算。

### 2. Official/native mechanisms

研究 Codex / Claude 当前官方或原生 usage 来源：

- native CLI output
- local session metadata
- hooks/events
- status/API
- usage commands

优先官方已有数据，不自己解析脆弱输出。

### 3. Mature OSS

重点检查之前提过的 Vibe Usage，以及其它成熟的 local AI coding usage tracker。

判断：

- 支持哪些 Agent
- 数据源是什么
- 是否直接读取本地文件
- 是否有可复用 parser/library
- 是否需要 daemon/database
- 是否可只复用最小数据采集层

Margin 不复制完整 dashboard。

## Required semantics

区分：

- exact native token count
- provider-reported usage
- reconstructed/estimated usage

Margin 第一版只接受前两类作为真实显示。

任何 estimated/reconstructed 数据默认不要进入 Usage Bar。

## Desired architecture

优先寻找类似：

`Native Usage Source → Normalized Usage Record → Usage Bar`

不要把 Usage 加回 Handoff Core。

Usage 与 Session/Handoff 保持解耦。

建议标准化字段最少：

- provider / agent
- model
- inputTokens
- outputTokens
- cachedTokens（如存在）
- totalTokens
- timestamp
- sessionId（如可关联）
- provenance

## Questions to answer

1. Codex 今天的真实 Token 数据能否取得？
2. Claude Code 能否取得？
3. 能否区分 Agent / Model？
4. 是否能按“今天”聚合？
5. 数据刷新成本如何？
6. 哪些数据来源是稳定官方接口，哪些只是文件实现细节？
7. Vibe Usage 值不值得直接复用？
8. 最小实现 Slice 是什么？
9. 哪些 Agent 第一版应该明确显示 `—`？

## No-go

不要：

- 写代码
- 加数据库
- 做 daemon
- 做实时监控
- 做 cost dashboard
- 用 bytes/message length/tokenizer 估算
- 修改 Handoff Core

## Output

1. Current repo/local findings
2. Codex source
3. Claude source
4. OSS comparison
5. provenance/reliability table
6. recommended architecture
7. minimum V1 scope
8. implementation files likely involved
9. model + reasoning recommendation for implementation
10. verdict

最终：

`PASS — usage source identified for implementation`

或

`PARTIAL — <missing provider/source>`


## 当前状态

- **Confirmed** 当前仓库 <repo>；branch=main；HEAD=a247e75ab9e78cce7853e3f281b85459a4f25e7c；292 个已跟踪修改/未跟踪文件。

## Progress

- **Uncertain · Historical** Historical validation: unknown; no direct test result was recovered from the frozen Session.

- **Uncertain · Current** Current validation: unknown; historical tests have not been rerun against the current repository observation.

## Historical Report

- **Inferred · Historical** ## 1. Current repo/local findings

- **Inferred · Historical** Terminal assistant report (excerpt): ## 1. Current repo/local findings 已找到真实来源，且本机有可验证样本： - Codex：`%USERPROFILE%\.codex\sessions\` 与 `archived_sessions\` 中共见 875 条 `token_usage_record`；每条都有 `response_id`，本机无重复。 - 每条 Codex 记录含 `input_tokens`、`cached_input_tokens`、`cache_write_input_tokens`、`output_tokens`、`reasoning_output_tokens`、`total_tokens`，以及 `session_id`、`turn_id`、时间戳。 - Claude Code：`%USE 已找到真实来源，且本机有可验证样本： - Codex：`%USERPROFILE%\.codex\sessions\` 与 `archived_sessions\` 中共见 875 条 `token_usage_record`；每条都有 `response_id`，本机无重复。 - 每条 Codex 记录含 `input_tokens`、`cached_input_tokens`、`cache_write_input_tokens`、`output_tokens`、`reasoning_output_tokens`、`total_tokens`，以及 `session_id`、`turn_id`、时间戳。 - Claude Code：`%USERPROFILE%\.claude\projects\**\*.js ## 6. Recommended architecture ```text Codex JSONL source ─┐ ├─> NormalizedUsageRecord ─> on-demand Today aggregator ─> Usage Bar Claude JSONL source ┘ ## 7. Minimum V1 scope 1. 仅支持 Codex Desktop/CLI JSONL 与 Claude Code JSONL。 2. 一次 bar 初始化或用户显式刷新时流式扫描；不轮询、不常驻监控。 3. 同时扫描 Codex active 与 archived，并用 `response_id` 去重。 4. Claude 用 assistant `uuid` 去重；本机已证实有 116 条物理重复。

## 失败 / 已拒绝

- **Confirmed** 命令进程失败：node -e "const fs=require('fs'),path=require('path'),os=require('os'); const home=os.homedir(); function walk(d, a=[]){if(!fs.existsSync(d))return a; for(const e of fs.readdirSy...；exit_code=1

- **Confirmed** 命令进程失败：@'；exit_code=1

## Open Issues

- **Uncertain** 20 个内部操作在捕获证据中没有明确终态（含空补丁返回、裁剪）；这不是当前阻塞清单。已存在文件只能证明当前存在，不能倒推历史命令成功。

## 测试

- **Uncertain** 冻结 Session 未识别到直接测试执行/结果，不能声称测试已通过。

## Historical Intent

- **Inferred** Implementation model recommendation

## Current Applicability

- **Unknown** No structured repo targets are available for reconciliation.

## Evidence Pointers

- 快照：<repo>\docs\validation\recovery-handoffs-postfix-r7\session-01a07786-adf5-77a3-91ba-e4a75ceda7e7.jsonl
- SHA-256：0787744584fe6f29bc428a725d387d582eaa7297679d4d41ceb23754a24d9408
- Workspace：<repo>
- call:L<n>/op<m> 指向 evidence 的 operations；file:* / repo:git 指向 repo-truth。
- 接手时读证据而非直接执行历史代码片段。
