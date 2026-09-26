# Margin Distiller Phase 1 PoC

本轮最小实现已建立 **Phase 0 Evidence → 原始调用/结果关联 → 刷新 Repo Truth → 分级 Distilled State → Handoff**。优先恢复可追溯的执行事实，不把 Assistant 自述当任务完成，也不为达到固定 Token 数而裁掉用户约束。

这只是独立实验，未接入正式 Margin Core、Pi runtime 或 UI。没有新增 Session Discovery/原生 Session parser，没有修改 continues，没有执行原始 Session 中的命令。

## 输入与运行

默认固定复用 `../phase0-continues/output/baseline-context.json` 的证据层，并验证冻结 JSONL 的 SHA-256。standard Handoff 只用于比较。运行时重新读取当前 Git 和相关 Workspace 文件；不重新扫描历史目录、不更新 Phase 0 的副本。

从 Margin 根目录执行：

```powershell
npm.cmd ci --prefix experiments/phase1-distiller --ignore-scripts --no-audit --no-fund
.\.runtime\node-v22.23.1-win-x64\node.exe --test experiments/phase1-distiller/distiller.test.mjs
.\.runtime\node-v22.23.1-win-x64\node.exe experiments/phase1-distiller/run-distiller.mjs
```

输出均为本地忽略文件：

- [evidence-layer.json](output/evidence-layer.json)：需求、Assistant claim、外层调用/返回、内部操作、证据指针与无法恢复的原因。
- [repo-truth.json](output/repo-truth.json)：新读取的 branch、HEAD、未跟踪/已跟踪修改、相关文件存在性、SHA-256、补丁内容核对、报告时效。
- [distilled-state.json](output/distilled-state.json)：带 Confirmed/Inferred/Uncertain 和引用 ID 的状态。
- [margin-handoff.md](output/margin-handoff.md)：供接手者阅读的交接，不覆盖接手时新的用户要求。
- [measurements.json](output/measurements.json)：同一离线编码下的长度、覆盖计数及输入文件保留校验。

接手质量的具体核对与局限见 [evaluation.md](evaluation.md)。这份 Handoff 是对 Phase 0 源样本的复原；不是把源样本中的 Phase 0 要求重新授权为当前 Phase 1 的开发目标。

## Evidence Layer 的边界

输入的 25 次外层工具调用有 24 次能按唯一 call_id 匹配到返回，1 次在冻结边界没有返回。静态解析恢复 37 个内部操作；包含 3 个不同文件的 edit/write 意图，且识别出安装的延后完成。

使用 [Acorn](https://github.com/acornjs/acorn/tree/master/acorn) 8.18.0 只构建语法树，支持本样本出现的顶层 `text(await tools.xxx(...))`、静态参数、`Promise.all/allSettled([...])` 后按顺序 `forEach(text)` 输出。不使用 eval/Function/vm，不执行历史代码，不把字符串中出现的工具名当作实际调用。

关联有三层：

1. 原生 call_id 连接外层调用和返回；重复 ID、缺失返回不猜测。
2. 只有静态输出顺序明确、输出未损坏、输出数量一致时，才把返回值对应到内部操作。不能可靠关联时保留调用意图，结果 Uncertain。
3. `exec` cell ID 的 `wait` 补回分次发出的返回；shell session_id 的 `write_stdin` 关联进程后续完成。最初返回句柄不是成功；外层完成也不是所有内部操作成功。

Evidence 中 `call:L65/op2` 等 ID 的 L 是冻结 JSONL 的行号；`codeRange` 是 exec 输入的起止字符偏移；`outputSlot` 是整个 exec（可能跨 wait）的有序输出序号。未裁剪的工具输入、结果及原始行指针留在证据层，Handoff 只给需要接手的事实和引用。

识别种类包括 User requirement、Assistant claim、Tool call/result、File edit/write、Shell command、Test execution/result、Git state、Workspace state。shell 中的写文件模式只记为可能写入，不声称能解析任意 PowerShell/bash 脚本的全部副作用。直接 patch、edit_file、write_file 有文件目标；普通测试入口有进程结果。复杂脚本间接执行测试、动态调用、分支/循环、非标准输出均保留限制。

## 真实性规则

| 状态 | 本 PoC 的含义 |
| --- | --- |
| Confirmed | 请求确实出现、工具明确 exit_code/错误、进程明确返回，或当前 Git/文件的直接观测；仅限陈述自身的范围 |
| Inferred | 从历史需求推定的目标和安全接手顺序；已有测试报告所声称的通过结果，不等于当前代码的新测试 |
| Uncertain | `{}` 不能明确证明 patch 成功、调用未返回、输出截断/错配、缺少测试记录、文件缺失、已识别的自述与事实冲突 |

`Completed` 保存的是“历史命令进程成功返回”“当前文件已存在”等具体事实，不自动升级成“整个用户目标完成”。复合 shell 的 exit_code 只证明整个进程的退出结果，不证明每个内部语句成功。

空 patch 返回保留 unknown。当前文件和 Add 文本一致，可以确认当前内容；Update 添加行存在，只能确认这些行现在存在，不能证明顺序、归属和完整历史补丁成功。当前 Git dirty 不归因给源 Session。

安装失败后的同命令、同 cwd 成功重试会关联 `resolvedBy`，旧失败不会成为永久禁用方案。Assistant 的“全部测试通过”与最新失败测试相冲突，或者其声称创建的文件当前缺失，会进入 Uncertain，不进入完成列表。其他复杂自然语言冲突尚不能自动识别；所有 Assistant claim 都保留在 Evidence，不自动采信。

## Repo Truth

每次生成都新读取 branch（允许 detached HEAD）、HEAD 和 NUL 分隔的 porcelain Git 状态。仅检查证据涉及的编辑目标，以及本次指定的四个 Phase 0 产物。保存文件哈希、大小、时间和内容核对结果；读取前后再核对 Git 与相关文件，变化时降为 Uncertain。不存在/无法读取的 Workspace 或非 Git 目录保留未知状态，不复用旧 SHA 冒充当前值。

这不是锁住整个仓库的事务快照，刷新结束后仍可能有并发修改。未做全仓内容扫描，也未验证 node_modules 全部依赖仍可执行，因此不会把历史安装成功当作今天依赖完整性的保证。

当前测试报告存在且引用源哈希一致，只能说明报告声称之前有 15 项通过；不能据此声称当前代码已经重新测试。冻结的真实样本本身没有直接测试执行，测试识别和冲突规则的其他覆盖来自合成夹具。

## 实测与局限

37 个内部操作的历史结果为 18 succeeded、5 failed、2 running、12 unknown；running 是捕获时的观察，不应直接用作当前阻塞列表。能够恢复 standard 遗漏的安装失败/成功链和 3 个修改目标。所有生成的状态条目有可解析证据引用。

已通过 15 项直接相关测试，包含真实样本回归和保守判定边界；没有运行全仓测试、UI 构建或 Release 验收。测试清单见 evaluation.md；Token 数和文件哈希以 output/measurements.json 为准。

Token 使用 [js-tiktoken](https://github.com/dqbd/tiktoken/tree/main/js) 1.0.21 / o200k_base 离线统一计数，不是 GPT-6 的计费或运行时 tokenizer 声明。明确分列不含 bootstrap/私有 reasoning 的可见输入口径，避免用原始文件中大量非开发内容夸大压缩收益。

尚未验证独立 Agent 的真实 Continuation Quality。当前确定性规则对业务目标、技术决策理由、唯一下一处代码改动提炼有限，Next Step 仍以“核对当前产物、只补缺失项”为主。当前假设获得事实恢复层面的支持，不能据此宣布真实续接效果已经成立。

## 文件与 Git 范围

开始状态保存在 `git-before.json`：`main @ 0836e800a4bf386e58ec1e9c02be5b7279497c9f`。其中 30 个原有未提交文件（含 Phase 0 的 7 个实验文件）以及 10 个 Phase 0 产物的哈希在每次生成时校验。没有 stage/commit/reset。

新增仅本目录：`.gitignore`、`package.json`、`package-lock.json`、`git-before.json`、`evidence.mjs`、`distiller.mjs`、`run-distiller.mjs`、`distiller.test.mjs`、`README.md`、`evaluation.md`。依赖及 output 目录被忽略。原有根依赖文件、业务代码、Phase 0 文件及产物均未修改。
