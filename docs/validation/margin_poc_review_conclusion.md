# Margin Phase 0/1 PoC — Review 结论

> Review 阶段交付物（对应 `Margin_Phase0_PoC_Plan.md` 第 11 节 Experiment → **Review** 的最后一步）。
> 回答计划反复指向的唯一核心问题，并据此给出 Go/No-Go 裁决。
>
> 成文日期：2026-10-02。本文只汇总并复核**已冻结的既有证据**，没有重跑任何 Agent；唯一新增动作是用与 Phase 1 完全相同的离线 tokenizer（`js-tiktoken 1.0.21 / o200k_base`）对正式基准所用的 12 份 handoff 补测 token 数，该计量已通过 Phase 1 冻结值复现校验（见附录 A）。

---

## 1. 一句话结论

> **在协议有效的单模型正式对照中，接手 Agent 读取中位约 1,958 token 的 Margin Handoff，在 10/12 个产出可解析结果的 run 上恢复了全部 5/5 个 ground-truth 关键字段，即约 1.87 个经盲评确认的正确字段 / 每 1K handoff token（按含两个输出失败的 as-run 口径为 1.56）。Handoff 的体量约为原始会话可见证据的 0.7%–3.8%（字节中位压缩 99.4%）。**

**裁决：有条件 Go。** "用极少上下文恢复高保真开发状态"这一核心假设，在**离线事实恢复**和**单模型、可解析 run 的真实续接**两个层面获得支持，压缩策略与证据分层架构值得继续。但 R7 正式全量重跑**没有证明 Handoff 相对全量上下文存在整体优势**（as-run 字段正确率 B 83.3% 低于 A 91.7%，速度持平），因此**尚不足以宣称跨 Agent 产品级续接成立**。继续的前提是先通过第 7 节列出的四个 gate。

---

## 2. 核心问题的操作化口径

计划的核心问题是「**每 1K Token 能恢复多少有效开发状态？**」（计划 L175），目标区间「默认 Handoff 控制在约 1K–3K Token」（L132）。为避免用一个漂亮但失真的比率回答，本文先固定口径：

- **「有效开发状态」=** 冻结 ground truth 的 5 个接手关键字段：`Goal / Progress(已完成) / Pending(未决) / Historical Validation(历史校验) / Recommended Follow-up(下一步)`，每字段经盲评判对/错，每 case 满分 5 分（12 case × 5 = 60 字段）。这是评测 harness 预先冻结的定义，不是本文新造。
- **「恢复」=** 一个**全新、隔离**的接手 Agent，只凭给定输入产出结构化续接 JSON，由盲评对照 ground truth 判分。
- **「每 1K Token」的分母必须说清是哪一段 token。** 存在两个不能混用的分母：
  1. **Handoff 自身体量**（B 臂真正读入的压缩产物）——本文据此报告「字段 / 每 1K handoff token」的密度；
  2. **接手 Agent 的 provider 实际输入 token**——由于所用任务运行时拿不到 provider 上报的 input token，该分母**从未被记录，本文不估算**（与既有报告一致）。
- 因此本文**不**报告「每 1K token 的边际恢复率相对不读 Handoff 提升多少」——该因果量需要 provider token 与 A/B 等输入隔离，当前证据不支持。

---

## 3. 三条证据链

### 3.1 压缩体量（字节，12 个真实历史 Codex 会话）

R7-full 冻结 manifest（`recovery-handoffs-r7-full/manifest.json`）：

| 指标 | 原始会话（字节） | Handoff（字节） | 压缩率 |
|---|---:|---:|---:|
| 中位 | 2,007,309.5 | 7,486 | **99.44%** |
| 均值 | 2,063,724.4 | 10,486 | 99.36% |
| 区间 | — | — | 97.99% – 99.83% |

Phase 1 单样本的**token 口径**（`experiments/phase1-distiller/output/measurements.json`，固定 o200k_base）：

| 输入口径 | Token | 最终 Handoff 占比 |
|---|---:|---:|
| 原始 JSONL | 387,346 | — |
| Phase 0 完整 Context JSON | 408,763 | 0.73%（压缩 99.27%） |
| 可见对话 + 完整工具文本（剔除私有 reasoning/bootstrap） | 74,432 | 3.81% |
| continues standard Handoff | 1,893 | — |
| **Margin Handoff** | **2,835** | 基准 |

> 压缩率本身**不**等于续接质量——早期版本正是在 99.6% 字节压缩下出现 0/12 五字段全保（见 3.2），该教训在既有报告中已明确记录，本文不重复用高压缩率冒充保真证据。

### 3.2 语义保真的迭代演化（离线 ground-truth 核对）

「五字段是否被有界、带源链接地保留」的人工严格语义核对（非标题/关键词匹配）：

| 版本 | Goal | Progress | Pending | Validation | Follow-up | **五字段全保** |
|---|---:|---:|---:|---:|---:|---:|
| pre-fix Handoff | 12/12 | 1/12 | 0/12 | 1/12 | 0/12 | **0/12** |
| postfix Handoff | 12/12 | 8/12 | 3/12 | 12/12 | 1/12 | **0/12** |
| R7 定向复检（5 个原失败 B case） | — | — | — | — | — | **5/5**（25/25 字段） |
| R7-full 正式（B 臂，可解析的 10 run） | — | — | — | — | — | **10/10**（50/50 字段） |

关键的保守性设计：postfix 起，缺失字段**不**用未标注的 assistant 叙述回填——`[]` 不被当作「无待办」，未返回调用不被当作失败，历史文件存在不倒推历史命令成功。Phase 1 的 `distilled-state.json` 对每条事实打 `Confirmed / Inferred / Uncertain` 与证据指针（本样本恢复了 5 条已确认完成、5 条已确认失败含失败→重试成功链、3 个已确认变更文件、5 条当前仓库事实、1 条保守下一步）。

### 3.3 真实接手 A/B 对照（R7-full，协议有效 24/24）

`docs/validation/margin_continuation_ab_deepseek_r7.md`：24/24 干净隔离 run、24 份隔离证书、唯一会话、平衡配对顺序、输入冻结、出结果先冻结再揭晓 ground truth、无静默重试。模型单一：`deepseek/deepseek-v4-flash`（thinking high）。

- **A 臂**（直接读原始历史会话恢复）：55/60 字段（91.67%），11/12 全五字段。
- **B 臂**（读 Margin R7 Handoff 恢复）：as-run 50/60（83.33%），10/12 全五字段；其中 **10 个产出可解析 JSON 的 run 全部 5/5（100%）**。
- **两个 B 的 0/5 是输出层事故，非 Handoff 内容缺失**：case-02-B 无最终文本（tool-call-only stop），case-09-B 只给了 prose 无可解析 JSON；报告明确记载这两份 handoff 本身含完整源内容。
- **时间无整体优势**：B 仅在 6/12 对更快，配对中位 −2.05% / 均值 +2.49%（即基本持平）。
- provider 输入 token 未记录，故无端到端 token 节省的严格数字。

---

## 4. 直接回答：每 1K Token 恢复了多少有效开发状态

下表 handoff token 为**本文新增实测**（方法与校验见附录 A），B 臂分数取自冻结的 R7 正式报告：

| Case | Handoff (token) | B 得分 | 可解析 | 正确字段 / 1K token |
|---|---:|---:|---|---:|
| case-01 | 2,073 | 5/5 | ok | 2.41 |
| case-02 | 1,702 | 0/5 | **NO-JSON** | 0 |
| case-03 | 1,694 | 5/5 | ok | 2.95 |
| case-04 | 1,510 | 5/5 | ok | 3.31 |
| case-05 | 1,773 | 5/5 | ok | 2.82 |
| case-06 | 2,974 | 5/5 | ok | 1.68 |
| case-07 | 5,699 | 5/5 | ok | 0.88 |
| case-08 | 1,726 | 5/5 | ok | 2.90 |
| case-09 | 3,665 | 0/5 | **NO-JSON** | 0 |
| case-10 | 4,205 | 5/5 | ok | 1.19 |
| case-11 | 1,843 | 5/5 | ok | 2.71 |
| case-12 | 3,194 | 5/5 | ok | 1.57 |
| **合计 / 中位** | **中位 1,958；均值 2,672；区间 1,510–5,699** | **50/60** | 10/12 | — |

- **按 as-run（全部 12 例）**：50 个正确字段 / 32,058 handoff token = **1.56 正确字段 / 1K token**。
- **按可解析 run（10 例，真实反映「读懂 handoff」的上界）**：50 / 26,691 = **1.87 正确字段 / 1K token**；逐 case 中位密度 **2.56 字段 / 1K**。
- 计划 1K–3K 目标带：**8/12** 落入；4 份超出（最大 case-07 5,699 token，对应体量最大的一类历史会话）。
- **最有代表性的单点表述**：在一份约 **2K token** 的 handoff 上，可解析的接手 run 稳定恢复 **5 个**接手必需的正确事实（目标 / 已完成 / 未决 / 历史校验 / 下一步），相当于约 **2.5 个经盲评确认的字段 / 1K token**。

---

## 5. 关键洞察（避免被数字误导）

1. **Handoff 的价值是「输入体量压缩」，不是「精度独占」。** A 臂读完整原始会话也达到 91.7%，因此不能声称「只有 Handoff 才能恢复状态」。真实卖点是：把接手所需输入从约 **39 万–41 万 token（完整 Context）/ 7.4 万 token（可见证据）量级**压到 **约 2K token**，且在可解析 run 上字段正确率与全量上下文**持平（100% vs 91.7%）**。这让「跨 Agent、跨窗口、跨会话」传递状态在成本上变得可行——这才是 Margin 的存在理由。
2. **保真来自证据分层与置信度，而非更激进的截断。** 从 0/12 到可解析 run 100% 的提升，靠的是保留调用—结果配对、当前 Git/文件二次校验、Confirmed/Inferred/Uncertain 分级和「不回填」纪律，同时允许 handoff 比 standard 更长（2,835 vs 1,893 token）。继续盲目压缩会回退到 pre-fix 的失败。
3. **当前主要风险已从「压缩丢事实」转移到「接手 Agent 不稳定产出结构化结果」。** 两个 B 失败都不是读不懂，而是没吐出可解析 JSON。这把下一阶段的工程重心从 distiller 移到**输出协议的强制与兜底**。
4. **越长的 handoff 密度越低但仍满分**（case-07/10），说明体量由源会话复杂度驱动；是否对超大 case 做分层（摘要 + 按需取证）是后续优化点，但不能以牺牲五字段为代价。

---

## 6. 局限与未证明项（诚实分级）

**已验证（冻结、可复现）**

- 12 真实历史会话的字节压缩率（SHA 对齐 manifest）；Phase 1 token 口径（o200k_base）。
- 离线五字段保真从 0/12 → 可解析 run 100% 的迭代链，每条事实带证据指针与置信度。
- R7-full 24/24 协议有效的单模型 A/B 结果与隔离证书。

**仅单模型 / 单快照证据（不可外推）**

- 全部真实续接结果来自 `deepseek/deepseek-v4-flash` 一个模型、一个仓库快照、12 个 Margin 自身开发会话。计划设想的 Claude / Codex / GPT-6 跨 Agent 对照**尚未执行**。
- 样本主要是 Margin 自身的工程开发，**缺独立业务功能的「失败—修复—测试」闭环**（Phase 1 README 已自述此取样偏差）。
- 「字段 / 1K token」密度依赖人工盲评，具主观性（评分理由已随冻结记录可审计）。

**未做 / 未证明（对应 CHANGELOG「Not Yet Complete」的 D 项）**

- provider 上报 input token 未记录，无法给端到端 token 节省的严格分母；更早的 24-run 恢复基准因运行时无法隔离文件系统、无法取 input token 而被如实判为 **PARTIAL（0/24 有效）**。
- 计划 Stage 3 的 **50-task 评测、A/B/C 三基线、recall 测量、真实用户研究均未开展**。
- 生产 chat 路径尚未迁移到 Pi，凭证管理与 provider 显式配置仍是前置设计缺口。

---

## 7. Go/No-Go 裁决与继续的 gate

**裁决：有条件 Go（继续投入 distiller / 证据架构），但把「产品级跨 Agent 优势」设为待证假设而非既成结论。**

进入下一阶段前必须先关闭的四个 gate：

1. **输出稳定性 gate（最高优先，直接对应两个 NO-JSON 失败）**：强制接手侧结构化输出（schema 校验 + 失败重试/兜底），把 as-run 正确率拉到与可解析 run 一致，再谈保真。
2. **真实跨 Agent gate**：在 ≥2 个异质模型（至少含计划点名的 Claude 与一个 GPT 系）上复跑同一冻结 12 case，检验 handoff 的模型无关性。
3. **独立样本 gate**：选取含完整「失败—修复—测试」闭环、且非 Margin 自身的开发 checkpoint，固定接手问题做 A/B，检验是否重复修改 / 误判测试状态 / 漏掉必做下一步。
4. **严格 token gate**：换到能上报 provider input token 且支持每 run 文件系统 allowlist 的运行时，重跑 24-run 恢复基准，把「约 0.7%–3.8% 体量」升级为「端到端输入 token 节省 + recall」的可发布数字；随后再扩展到 50-task 与用户研究。

在 gate 1–3 通过前，不启动桌面浮窗 / UI 等产品面扩张（与计划 L451「之后再决定是否开发桌面浮窗 / UI」的顺序一致）。

---

## 8. 证据索引

- 计划与问题定义：[`Margin_Phase0_PoC_Plan.md`](../../Margin_Phase0_PoC_Plan.md)（L132 目标带、L175 核心问题、L447 Review、L469 总原则）
- 技术基线与单样本事实恢复：[`experiments/phase0-continues/README.md`](../../experiments/phase0-continues/README.md)、[`experiments/phase1-distiller/evaluation.md`](../../experiments/phase1-distiller/evaluation.md)
- Phase 1 冻结测量与蒸馏状态：`experiments/phase1-distiller/output/measurements.json`、`distilled-state.json`（本地原始证据，gitignored）
- 压缩基准：[`margin_handoff_compression_benchmark.md`](./margin_handoff_compression_benchmark.md)、[`..._postfix.md`](./margin_handoff_compression_benchmark_postfix.md)
- 正式 A/B 与定向复检：[`margin_continuation_ab_deepseek_r7.md`](./margin_continuation_ab_deepseek_r7.md)、[`margin_continuation_targeted_r7.md`](./margin_continuation_targeted_r7.md)
- R7 handoff 与冻结 manifest：[`recovery-handoffs-r7-full/`](./recovery-handoffs-r7-full/)（含 `manifest.json` 逐 case 字节/SHA）
- 失败的 24-run 恢复基准（诚实 PARTIAL 记录）：[`margin_recovery_benchmark_rerun.md`](./margin_recovery_benchmark_rerun.md)

## 附录 A：本文 token 计量的可复现性与校验

- 计量器：`js-tiktoken@1.0.21`，编码 `o200k_base`，与 Phase 1 `measurements.json` 完全同一离线编码（非 GPT 计费或运行时 tokenizer 断言）。
- **校验**：同一调用对 Phase 1 两份冻结产物计量，精确复现 `baseline-continues-handoff.md = 1893`、`margin-handoff.md = 2835`，与冻结值**逐 token 相等**，据此才对 R7-full 的 12 份 `case-*.md` 计量并与冻结 B 臂分数关联。
- R7 handoff 的 token 数是本次 Review 的**新增测量**（原始证据只冻结了字节与 SHA，未记 token）；可在 `experiments/phase1-distiller` 恢复 `js-tiktoken@1.0.21` 后，对 `docs/validation/recovery-handoffs-r7-full/case-*.md` 以相同 `getEncoding('o200k_base').encode(text).length` 复算。
