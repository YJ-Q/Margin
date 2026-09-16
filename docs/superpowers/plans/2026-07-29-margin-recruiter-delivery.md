# Margin Recruiter Delivery Edition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Margin 双语 Case Study 顶部加入招聘方 3 分钟速览，提供中英文 PDF 与 GitHub 入口，并交付一套与案例证据一致的中文简历和面试表达材料。

**Architecture:** 使用 `case-study/content/recruiter-summary.json` 作为双语速览和静态资源地址的单一数据源，扩展现有内容合同与 `build-web.mjs`，把 `resources` 和各语言 `quickRead` 写入 `content.generated.js`。现有网页运行时增加独立速览渲染函数，不改变 10 章正文和章节导航；求职材料保存在独立 Markdown 文件中。完成后在隔离工作区验证、提交，并更新现有 Coze Web 项目。

**Tech Stack:** Node.js 20、Node 内置 test runner、原生 HTML/CSS/JavaScript、JSON、Markdown、Git、Coze CLI。

## Global Constraints

- 主要受众是国内 AI 产品经理招聘方；中文优先，英文速览保持同构。
- 保留现有核心标题、10 章完整正文、证据编号和编辑式证据视觉。
- 不新增运行时网络请求、第三方字体、CDN、分析脚本或 Cookie。
- 不新增邮箱、LinkedIn 或未提供的个人主页；公开联系入口使用 `https://github.com/YJ-Q/Echo`。
- 不虚构用户访谈、用户原话、留存率、满意度、转化率、团队或商业结果。
- 继续区分 `Implemented`、`Scenario-validated` 和 `Hypothesis`。
- 390×844 CSS 视口不得出现水平溢出；交互目标最小高度为 44px。
- PDF 使用同源相对路径；中文为 `../dist/margin-case-study.zh.pdf`，英文为 `../dist/margin-case-study.en.pdf`。
- 不修改 `case-study/content/case-study.zh.md`、`case-study/content/case-study.en.md`、产品运行代码、真实 SQLite 数据库或 `.env`。
- 实施开始前使用 `using-git-worktrees` 创建 `codex/margin-recruiter-delivery` 隔离分支，基于同时包含规格提交 `0014201` 与本计划提交的当前分支 HEAD。
- 每个行为变更严格执行 RED → GREEN → REFACTOR；不得先写实现后补测试。

---

## File Responsibility Map

| 文件 | 责任 |
|---|---|
| `case-study/content/recruiter-summary.json` | 语言无关资源地址与中英文速览的唯一内容源 |
| `case-study/content/job-application.zh.md` | 简历、60 秒介绍、5 分钟讲述、8 个追问及投递链接建议 |
| `scripts/case-study/lib/content-contract.mjs` | 校验速览结构、证据编号、资源地址和求职材料章节 |
| `scripts/case-study/build-web.mjs` | 合并完整案例、速览和资源地址并生成 `content.generated.js` |
| `case-study/web/content.generated.js` | 构建产物；不得手工维护 |
| `case-study/web/index.html` | 静态页面语义容器、跳转入口与无脚本降级 |
| `case-study/web/case-study.js` | 当前语言的首屏、速览、入口、正文和锚点渲染 |
| `case-study/web/styles.css` | 速览与入口的编辑式视觉、移动端和焦点状态 |
| `test/caseStudyContentContract.test.js` | 内容模型、证据和求职材料合同 |
| `test/caseStudyWeb.test.js` | 构建产物、DOM 钩子、链接、语言和离线合同 |
| `test/caseStudyAssets.test.js` | PDF 与既有图片资源合同 |
| `case-study/REVIEW.md` | 最终测试、浏览器、部署与证据边界记录 |

---

### Task 1: Add the recruiter content contract and source files

**Files:**
- Create: `case-study/content/recruiter-summary.json`
- Create: `case-study/content/job-application.zh.md`
- Modify: `scripts/case-study/lib/content-contract.mjs`
- Modify: `test/caseStudyContentContract.test.js`

**Interfaces:**
- Consumes: `parseEvidenceMap(markdown)` and the existing evidence map rows.
- Produces: `validateRecruiterSummary(summary, evidenceRows): string[]`.
- Produces: `validateJobApplication(markdown): string[]`.
- Produces: JSON root fields `resources`, `zh.quickRead`, and `en.quickRead`.

- [ ] **Step 1: Write failing content-contract tests**

Add these imports and paths to `test/caseStudyContentContract.test.js`:

```js
import {
  parseEvidenceMap,
  parseCaseStudy,
  validateEvidenceRefs,
  validateSectionParity,
  validateRecruiterSummary,
  validateJobApplication
} from "../scripts/case-study/lib/content-contract.mjs";

const recruiterPath = new URL(
  "../case-study/content/recruiter-summary.json",
  import.meta.url
);
const jobApplicationPath = new URL(
  "../case-study/content/job-application.zh.md",
  import.meta.url
);
```

Append:

```js
test("recruiter summary keeps bilingual structure, resources, and known evidence", () => {
  const evidence = parseEvidenceMap(fs.readFileSync(evidencePath, "utf8"));
  const summary = JSON.parse(fs.readFileSync(recruiterPath, "utf8"));

  assert.deepEqual(validateRecruiterSummary(summary, evidence), []);
  assert.equal(summary.zh.quickRead.decisions.length, 3);
  assert.equal(summary.en.quickRead.decisions.length, 3);
  assert.equal(summary.resources.fullCaseAnchor, "overview");
  assert.equal(summary.resources.pdf.zh, "../dist/margin-case-study.zh.pdf");
  assert.equal(summary.resources.pdf.en, "../dist/margin-case-study.en.pdf");
  assert.equal(summary.resources.github, "https://github.com/YJ-Q/Echo");
});

test("Chinese job application kit contains every required interview section", () => {
  const markdown = fs.readFileSync(jobApplicationPath, "utf8");
  assert.deepEqual(validateJobApplication(markdown), []);
  assert.match(markdown, /尚未经过真实外部用户验证/);
  assert.doesNotMatch(markdown, /我们团队|带领团队|用户留存率|用户满意度/);
});

test("recruiter contract rejects unknown evidence and missing questions", () => {
  const evidence = parseEvidenceMap(fs.readFileSync(evidencePath, "utf8"));
  const summary = JSON.parse(fs.readFileSync(recruiterPath, "utf8"));
  const invalidSummary = structuredClone(summary);
  invalidSummary.zh.quickRead.decisions[0].evidenceIds = ["E999"];

  assert.deepEqual(
    validateRecruiterSummary(invalidSummary, evidence),
    ["Unknown recruiter evidence id: E999"]
  );
  assert.match(
    validateJobApplication("# 简历项目描述\n\n内容"),
    /Missing job application section/
  );
  assert.match(
    validateJobApplication(
      `${fs.readFileSync(jobApplicationPath, "utf8")}\n用户满意度达到 95%。`
    ),
    /Forbidden portfolio claim/
  );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test test/caseStudyContentContract.test.js
```

Expected: FAIL because `validateRecruiterSummary` and `validateJobApplication` are not exported, and both new content files are absent.

- [ ] **Step 3: Implement the validator functions**

Append to `scripts/case-study/lib/content-contract.mjs`:

```js
const REQUIRED_JOB_SECTIONS = [
  "简历项目描述",
  "60 秒项目介绍",
  "5 分钟面试讲述稿",
  "高频追问与回答",
  "投递链接组合"
];

const FORBIDDEN_PORTFOLIO_CLAIMS = [
  /用户(?:留存率|满意度)\s*(?:为|达到|提升)/i,
  /(?:retention|satisfaction)\s+(?:reached|increased|improved)/i,
  /“[^”]{5,}”\s*——\s*(?:用户|受访者)/i
];

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateRecruiterSummary(summary, evidenceRows) {
  const errors = [];
  const resources = summary?.resources;
  const knownEvidence = new Set(evidenceRows.map((row) => row.id));

  if (resources?.fullCaseAnchor !== "overview") {
    errors.push("Recruiter fullCaseAnchor must be overview");
  }
  if (resources?.pdf?.zh !== "../dist/margin-case-study.zh.pdf") {
    errors.push("Recruiter Chinese PDF path is invalid");
  }
  if (resources?.pdf?.en !== "../dist/margin-case-study.en.pdf") {
    errors.push("Recruiter English PDF path is invalid");
  }
  if (resources?.github !== "https://github.com/YJ-Q/Echo") {
    errors.push("Recruiter GitHub URL is invalid");
  }

  for (const lang of ["zh", "en"]) {
    const quickRead = summary?.[lang]?.quickRead;
    if (!quickRead) {
      errors.push(`Missing recruiter language: ${lang}`);
      continue;
    }
    for (const key of ["label", "title", "summary"]) {
      if (!isNonEmptyString(quickRead[key])) {
        errors.push(`Missing recruiter field: ${lang}.quickRead.${key}`);
      }
    }
    if (!isNonEmptyString(quickRead.problem?.title)
      || !isNonEmptyString(quickRead.problem?.body)) {
      errors.push(`Missing recruiter problem: ${lang}`);
    }
    if (!Array.isArray(quickRead.decisions)
      || quickRead.decisions.length !== 3) {
      errors.push(`Recruiter decisions must contain 3 items: ${lang}`);
    } else {
      for (const decision of quickRead.decisions) {
        if (!isNonEmptyString(decision.title)
          || !isNonEmptyString(decision.body)) {
          errors.push(`Invalid recruiter decision copy: ${lang}`);
        }
        for (const id of decision.evidenceIds || []) {
          if (!knownEvidence.has(id)) {
            errors.push(`Unknown recruiter evidence id: ${id}`);
          }
        }
      }
    }
    if (!isNonEmptyString(quickRead.delivery?.title)
      || !isNonEmptyString(quickRead.delivery?.body)
      || !Array.isArray(quickRead.delivery?.items)
      || quickRead.delivery.items.length < 4) {
      errors.push(`Invalid recruiter delivery: ${lang}`);
    }
    const evidence = quickRead.evidence;
    for (const key of [
      "title",
      "body",
      "implemented",
      "scenarioValidated",
      "hypothesis"
    ]) {
      if (!isNonEmptyString(evidence?.[key])) {
        errors.push(`Missing recruiter evidence field: ${lang}.${key}`);
      }
    }
  }

  const serialized = JSON.stringify(summary);
  if (FORBIDDEN_PORTFOLIO_CLAIMS.some((pattern) => pattern.test(serialized))) {
    errors.push("Forbidden portfolio claim in recruiter summary");
  }

  return [...new Set(errors)];
}

export function validateJobApplication(markdown) {
  const errors = [];
  for (const section of REQUIRED_JOB_SECTIONS) {
    if (!markdown.includes(`## ${section}`)) {
      errors.push(`Missing job application section: ${section}`);
    }
  }
  const questions = [...markdown.matchAll(/^### Q\d+\./gm)];
  if (questions.length !== 8) {
    errors.push(`Job application must contain 8 questions; got ${questions.length}`);
  }
  if (FORBIDDEN_PORTFOLIO_CLAIMS.some((pattern) => pattern.test(markdown))) {
    errors.push("Forbidden portfolio claim in job application");
  }
  return errors;
}
```

- [ ] **Step 4: Create the structured bilingual recruiter summary**

Create `case-study/content/recruiter-summary.json` with:

```json
{
  "resources": {
    "fullCaseAnchor": "overview",
    "pdf": {
      "zh": "../dist/margin-case-study.zh.pdf",
      "en": "../dist/margin-case-study.en.pdf"
    },
    "github": "https://github.com/YJ-Q/Echo"
  },
  "zh": {
    "quickRead": {
      "label": "FOR RECRUITERS / 招聘速览",
      "title": "3 分钟理解 Margin",
      "summary": "我独立把一个模糊的人类处境，收敛成产品定位、AI 行为原则、选择性记忆机制与可运行 MVP；当前证据证明系统能够工作，但不把技术验证包装成用户价值。",
      "problem": {
        "title": "问题不是用户不会提问，而是他此刻还没有整理好自己",
        "body": "人在疲惫、混乱或被多条生活线同时牵扯时，往往无法先写出一个合格提示词。Margin 尝试降低“先解释清楚自己，才能获得帮助”的门槛。这仍是创作者观察和待验证假设。"
      },
      "decisions": [
        {
          "title": "先接住，再推进",
          "body": "产品不把立即生成任务作为默认反应，而是先允许模糊表达，再形成一条用户愿意继续的活线。",
          "evidenceIds": ["E007", "E008"]
        },
        {
          "title": "选择性记忆，而不是无限记忆",
          "body": "记忆只在与当下相关时被召回；临时情绪不能自动变成长期身份，连续性也不能以打扰为代价。",
          "evidenceIds": ["E006", "E014", "H002"]
        },
        {
          "title": "低压力行动，而不是任务接管",
          "body": "系统只抬升一个可拒绝、可完成、可替换的下一步，不用积分、连续打卡或惩罚性提醒制造推进。",
          "evidenceIds": ["E013", "H003"]
        }
      ],
      "delivery": {
        "title": "独立完成从定位到运行的证据链",
        "body": "我承担产品定位、问题重构、MVP 范围、AI 和记忆机制、信息架构、视觉表达、实现、测试、验收与部署。",
        "items": [
          "10 章中英文产品策略案例",
          "可运行的聊天、状态、行动、学习、记忆与总结闭环",
          "6 张脱敏产品截图与 4 张策略图",
          "中英文 PDF 与公开双语网页"
        ]
      },
      "evidence": {
        "title": "证据边界",
        "body": "这里区分做出来、按场景能工作，以及对真实用户有价值。",
        "implemented": "核心产品闭环和主要界面已经实现。",
        "scenarioValidated": "自动化测试和预设场景已执行，并发现过学习相关性和主题提取误判。",
        "hypothesis": "尚未经过真实外部用户验证；陪伴感、连续性感受与留存不能宣称成立。"
      }
    }
  },
  "en": {
    "quickRead": {
      "label": "FOR RECRUITERS / QUICK READ",
      "title": "Understand Margin in 3 minutes",
      "summary": "I independently translated an ambiguous human situation into a product position, AI behavior principles, selective memory, and a runnable MVP. The evidence shows that the system works under defined conditions; it does not present technical validation as user value.",
      "problem": {
        "title": "The problem is not poor prompting. The person may not be ready to organize the situation yet.",
        "body": "When people are tired, uncertain, or pulled across several live concerns, composing a complete prompt becomes part of the burden. Margin explores a lower-threshold way to begin. This remains a founder observation and a hypothesis to test."
      },
      "decisions": [
        {
          "title": "Receive first, advance second",
          "body": "The product does not default to generating tasks. It first accepts ambiguous expression, then forms one live thread the person may choose to continue.",
          "evidenceIds": ["E007", "E008"]
        },
        {
          "title": "Selective memory, not unlimited memory",
          "body": "A trace returns only when it is relevant to the present. Temporary emotion must not become permanent identity, and continuity must not become intrusion.",
          "evidenceIds": ["E006", "E014", "H002"]
        },
        {
          "title": "Low-pressure action, not task takeover",
          "body": "The system raises one dismissible, completable, replaceable next step without points, streaks, or punitive reminders.",
          "evidenceIds": ["E013", "H003"]
        }
      ],
      "delivery": {
        "title": "An independently delivered evidence chain",
        "body": "I owned product positioning, problem reframing, MVP scope, AI and memory behavior, information architecture, visual expression, implementation, testing, acceptance, and deployment.",
        "items": [
          "A ten-chapter Chinese and English product strategy case",
          "A runnable conversation, state, action, learning, memory, and reflection loop",
          "Six sanitized product screens and four strategy diagrams",
          "Chinese and English PDFs plus a public bilingual web edition"
        ]
      },
      "evidence": {
        "title": "Evidence boundary",
        "body": "The case separates what exists, what works in defined scenarios, and what remains a user-value hypothesis.",
        "implemented": "The core product loop and primary interfaces are implemented.",
        "scenarioValidated": "Automated rules and predefined scenarios were executed and exposed relevance and topic-extraction defects.",
        "hypothesis": "The product is not yet validated with external users; companionship, perceived continuity, and retention are not proven."
      }
    }
  }
}
```

- [ ] **Step 5: Create the Chinese job-application kit**

Create `case-study/content/job-application.zh.md` with:

```markdown
# Margin 求职表达材料

## 简历项目描述

独立完成个人 AI 连续性产品 Margin 的 0–1 产品设计与 MVP 落地，针对用户在疲惫或混乱时难以先组织清晰提示词的问题，将产品从通用聊天能力收敛为“先接住、保留活线、低压力继续”的第二自我式空间。负责产品定位、范围取舍、AI 行为、选择性记忆、信息架构、界面实现、测试验收与部署；已完成可运行闭环、双语 Case Study 和场景验证，尚未经过真实外部用户验证。

## 60 秒项目介绍

Margin 起点不是“再做一个聊天机器人”，而是一个更具体的问题：人在最需要支持时，往往恰好没有能力先把自己整理成清晰提示词。我把它重构成一个以连续性为核心的个人 AI 空间，并做了三个关键取舍：先接住再推进、选择性记忆而不是无限记忆、低压力行动而不是任务接管。我独立完成了定位、MVP 范围、AI 和记忆机制、信息架构、界面、实现、测试与部署。现在产品已经形成聊天、状态、行动、学习、记忆和总结的可运行闭环，也通过了自动化与预设场景验证；但它尚未经过真实外部用户验证，所以我不会把工程测试写成用户价值，下一步会优先验证用户是否真的需要这种跨会话连续性。

## 5 分钟面试讲述稿

### 1. 为什么选择这个问题

我观察到，很多 AI 产品要求用户先把目标、背景和输出形式说明清楚。但人在疲惫、混乱或同时被几件事牵扯时，最缺少的恰好就是这种组织能力。因此我没有从“模型还能增加什么功能”出发，而是从“用户还没有整理好时，产品如何让他开始”出发。

### 2. 为什么不是任务管理器

任务管理器默认目标已经清楚，核心是拆解、排序和执行。Margin 面对的是目标尚未形成、情绪和行动混在一起的时刻。它先允许用户用不完整的方式表达，再判断是否形成一条值得保留的活线。行动只是连续性闭环的一部分，不是产品的关系定位。

### 3. MVP 如何形成闭环

我保留了聊天、当前状态、学习、行动、选择性记忆、总结和可选朗读。聊天承接表达，状态聚合形成“现在”，学习和行动保存可继续的线，记忆在相关时召回，总结帮助用户回看。任何一个能力单独存在都不能证明定位，只有它们交换状态，才形成从表达、保留到继续的最小证据链。

### 4. AI 和记忆设计中的关键判断

AI 负责理解模糊表达、生成候选连接和组织自然语言；确定性系统负责状态、优先级、去重、完成与取消。记忆不是越多越好：临时情绪不能自动成为长期身份，被召回的内容要解释为什么与当下相关，证据不足时系统应当承认不知道。

### 5. 验收发现了什么

场景验收发现，学习线活跃时，一段无关的普通聊天可能被误判为学习尝试；主题提取也可能保留整句指令。这说明连续性如果缺少相关性门槛，会从帮助变成误解。这个发现让我把“是否应该记住和推进”看成比“是否能够记住”更重要的产品问题。

### 6. 下一轮如何验证

当前证据只说明系统已实现并在预设场景中工作，尚未经过真实外部用户验证。我会先做 5–8 人的定性研究确认问题是否真实存在，再做首次到场任务观察用户是否愿意在没有完整提示词时开始，最后用 7 天日记研究验证被召回的活线是否相关、打扰或遗漏。

## 高频追问与回答

### Q1. 为什么这不是普通聊天机器人？

普通聊天机器人优化单次回答，Margin 把跨会话连续性作为产品对象。它需要决定什么值得留下、为什么现在召回、如何把旧线索转成可拒绝的下一步，而不只是生成一段更好的回复。

### Q2. 为什么不直接做任务管理器？

因为目标用户进入产品时可能还没有明确任务。过早拆任务会把表达重新变成绩效要求。Margin 只在出现可行动线索时提供一个轻量下一步，并允许忽略、替换或回到对话。

### Q3. 没有真实用户数据，如何证明项目价值？

目前不能证明真实用户价值。我能证明的是问题已经被转化为一致的产品原则、核心闭环已实现、规则和预设场景可复现，并且验收发现了具体缺陷。真实需求、理解和留存必须通过下一阶段外部研究验证。

### Q4. 选择性记忆如何避免打扰和误判？

召回不只看时间，还看主题连续性、当前意图和核心锚点。临时情绪不直接升级为长期画像；证据不足时不生成稳定结论；用户需要能理解、纠正和删除被保留的内容。

### Q5. AI 与确定性系统如何分工？

AI 处理模糊语言、候选解释和自然语言组织。确定性系统处理状态、去重、优先级、完成、取消和备份。对用户有持续影响的决定不能只依赖一次不可解释的模型输出。

### Q6. 你独立完成了哪些工作？

我独立完成产品定位、问题重构、MVP 范围、非目标、AI 行为、记忆与状态机制、信息架构、视觉表达、前后端实现、测试、场景验收、Case Study 和部署。

### Q7. MVP 为什么选择这些能力？

选择标准不是功能重要性，而是它是否构成核心关系的最小证据链。聊天负责承接，状态负责形成现在，学习和行动负责继续，记忆负责跨会话连接，总结负责回看。重规划、游戏化、诊断和语音优先都不能直接验证这条链，因此被排除。

### Q8. 如果获得下一轮时间，你最先验证什么？

先验证问题而不是增加功能：目标用户是否真的把重复解释和丢失上下文视为负担；其次验证他们是否把首页和活线理解为陪伴与连续性，而不是温和包装的任务管理器。

## 投递链接组合

- 简历：使用公开双语 Case Study 首页。
- 国内招聘平台：Case Study 首页 + 中文 PDF。
- 英文沟通场景：Case Study 英文模式 + 英文 PDF。
- 深入技术或产品讨论：补充 GitHub 项目链接。
```

- [ ] **Step 6: Run the focused test and verify GREEN**

Run:

```powershell
node --test test/caseStudyContentContract.test.js
```

Expected: all content-contract tests PASS.

- [ ] **Step 7: Commit Task 1**

```powershell
git add case-study/content/recruiter-summary.json case-study/content/job-application.zh.md scripts/case-study/lib/content-contract.mjs test/caseStudyContentContract.test.js
git commit -m "feat: add recruiter content contract"
```

---

### Task 2: Merge recruiter data into the generated web content

**Files:**
- Modify: `scripts/case-study/build-web.mjs`
- Modify: `test/caseStudyWeb.test.js`
- Regenerate: `case-study/web/content.generated.js`

**Interfaces:**
- Consumes: `validateRecruiterSummary(summary, evidenceRows)`.
- Produces: `buildAllContent()` result `{ resources, zh, en }`.
- Produces: `zh.quickRead` and `en.quickRead` beside existing `meta` and `sections`.

- [ ] **Step 1: Write the failing build-contract test**

In `test/caseStudyWeb.test.js`, extend the existing generated-content test:

```js
test("generated web content contains recruiter resources and bilingual quick reads", () => {
  const content = buildAllContent();

  assert.equal(content.resources.fullCaseAnchor, "overview");
  assert.equal(content.resources.pdf.zh, "../dist/margin-case-study.zh.pdf");
  assert.equal(content.resources.pdf.en, "../dist/margin-case-study.en.pdf");
  assert.equal(content.resources.github, "https://github.com/YJ-Q/Echo");
  for (const lang of ["zh", "en"]) {
    assert.equal(content[lang].quickRead.decisions.length, 3);
    assert.match(content[lang].quickRead.evidence.hypothesis, /external|外部/i);
    assert.equal(content[lang].sections.length, 10);
  }
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test test/caseStudyWeb.test.js
```

Expected: FAIL because `buildAllContent()` does not yet return `resources` or `quickRead`.

- [ ] **Step 3: Extend the web builder**

Add `validateRecruiterSummary` to the imports in `scripts/case-study/build-web.mjs`:

```js
import {
  parseEvidenceMap,
  parseCaseStudy,
  validateEvidenceRefs,
  validateSectionParity,
  validateRecruiterSummary
} from "./lib/content-contract.mjs";
```

Replace `buildAllContent()` with:

```js
export function buildAllContent() {
  const zhText = read("case-study.zh.md");
  const enText = read("case-study.en.md");
  const evidence = parseEvidenceMap(read("evidence-map.md"));
  const recruiter = JSON.parse(read("recruiter-summary.json"));
  const errors = [
    ...validateSectionParity(zhText, enText),
    ...validateEvidenceRefs(zhText, evidence),
    ...validateEvidenceRefs(enText, evidence),
    ...validateRecruiterSummary(recruiter, evidence)
  ];

  for (const [lang, text] of [["zh", zhText], ["en", enText]]) {
    const actual = parseCaseStudy(text).sectionIds;
    if (JSON.stringify(actual) !== JSON.stringify(requiredSections)) {
      errors.push(
        `${lang} sections must be ${requiredSections.join(",")}; got ${actual.join(",")}`
      );
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));

  return {
    resources: recruiter.resources,
    zh: {
      ...buildLanguageDocument(zhText),
      quickRead: recruiter.zh.quickRead
    },
    en: {
      ...buildLanguageDocument(enText),
      quickRead: recruiter.en.quickRead
    }
  };
}
```

- [ ] **Step 4: Regenerate the checked-in content**

Run:

```powershell
node scripts/case-study/build-web.mjs
```

Expected: `Built case-study\web\content.generated.js`.

- [ ] **Step 5: Run the web contract and verify GREEN**

Run:

```powershell
node --test test/caseStudyWeb.test.js
```

Expected: all web tests PASS, including exact generated-content equality.

- [ ] **Step 6: Commit Task 2**

```powershell
git add scripts/case-study/build-web.mjs test/caseStudyWeb.test.js case-study/web/content.generated.js
git commit -m "feat: build recruiter quick-read content"
```

---

### Task 3: Render the recruiter overview, actions, and bilingual links

**Files:**
- Modify: `case-study/web/index.html`
- Modify: `case-study/web/case-study.js`
- Modify: `case-study/web/styles.css`
- Modify: `test/caseStudyWeb.test.js`

**Interfaces:**
- Consumes: `caseStudyContent.resources`.
- Consumes: `caseStudyContent[lang].quickRead`.
- Produces: `renderHero(meta, quickRead, resources, lang): string`.
- Produces: `renderQuickRead(quickRead, lang): string`.
- Produces: internal anchor handlers for `#recruiter-summary` and `#overview`.

- [ ] **Step 1: Write failing DOM and source-contract tests**

Add to `test/caseStudyWeb.test.js`:

```js
test("web shell exposes recruiter overview and delivery footer hooks", () => {
  const html = fs.readFileSync(
    new URL("../case-study/web/index.html", import.meta.url),
    "utf8"
  );

  assert.match(html, /id="recruiter-summary"/);
  assert.match(html, /id="case-study-footer"/);
  assert.match(html, /href="#recruiter-summary"/);
  assert.match(html, /href="#overview"/);
});

test("runtime renders bilingual recruiter decisions and resource links", () => {
  const source = fs.readFileSync(
    new URL("../case-study/web/case-study.js", import.meta.url),
    "utf8"
  );

  assert.match(source, /function renderQuickRead\(/);
  assert.match(source, /quickRead\.decisions\.map/);
  assert.match(source, /resources\.pdf\[lang\]/);
  assert.match(source, /resources\.github/);
  assert.match(source, /rel="noreferrer"/);
  assert.match(source, /data-case-anchor/);
  assert.match(source, /function renderRecruiterFallback\(/);
  assert.match(source, /console\.error\("Missing recruiter quick-read content/);
  assert.doesNotMatch(source, /scrollIntoView/);
});

test("recruiter CSS keeps approved visual tokens and mobile single-column decisions", () => {
  const css = fs.readFileSync(
    new URL("../case-study/web/styles.css", import.meta.url),
    "utf8"
  );

  assert.match(css, /\.hero-actions\s*\{/);
  assert.match(css, /\.quick-read-grid\s*\{/);
  assert.match(css, /\.decision-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(css, /@media\s*\(max-width:\s*860px\)[\s\S]*?\.decision-grid\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(css, /\.case-link\s*\{[^}]*min-height:\s*44px/s);
  assert.doesNotMatch(css, /linear-gradient|radial-gradient|conic-gradient/i);
});
```

- [ ] **Step 2: Run the focused web test and verify RED**

Run:

```powershell
node --test test/caseStudyWeb.test.js
```

Expected: FAIL because the recruiter container, footer, render function, links, and CSS classes do not exist.

- [ ] **Step 3: Add semantic static hooks**

Replace the `<main>` line in `case-study/web/index.html`:

```html
      <main id="case-study-content" tabindex="-1">
        <a class="case-link case-link--text pre-render-link" href="#recruiter-summary">3 分钟速览</a>
        <a class="case-link case-link--text pre-render-link" href="#overview">查看完整案例</a>
        <section id="recruiter-summary" aria-label="招聘方 3 分钟速览"></section>
      </main>
      <footer id="case-study-footer" class="case-study-footer"></footer>
```

The static links provide a no-build semantic contract. Runtime rendering replaces the main contents and populates the footer.

- [ ] **Step 4: Extend language labels and add safe escaping**

Add these fields inside each `LANGUAGE_CONFIG` language:

```js
quickReadLabel: "招聘方 3 分钟速览",
quickReadAction: "3 分钟速览",
fullCaseAction: "查看完整案例",
pdfAction: "下载中文 PDF",
githubAction: "GitHub 项目",
footerLabel: "继续查看"
```

English values:

```js
quickReadLabel: "Three-minute recruiter overview",
quickReadAction: "3-minute overview",
fullCaseAction: "Read full case study",
pdfAction: "Download English PDF",
githubAction: "GitHub project",
footerLabel: "Continue exploring"
```

Add:

```js
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
```

- [ ] **Step 5: Replace the hero renderer**

Replace `renderHero(meta, lang)` with:

```js
function renderHero(meta, quickRead, resources, lang) {
  const labels = LANGUAGE_CONFIG[lang];
  return `
    <section class="case-hero" aria-labelledby="case-title">
      <p class="eyebrow">AI PRODUCT CASE STUDY · ${escapeHtml(meta.year)}</p>
      <h1 id="case-title">${escapeHtml(meta.title)}</h1>
      <p class="case-subtitle">${escapeHtml(meta.subtitle)}</p>
      <dl class="fact-strip">
        <div><dt>${labels.roleLabel}</dt><dd>${escapeHtml(meta.role)}</dd></div>
        <div><dt>${labels.stageLabel}</dt><dd>${escapeHtml(meta.stage)}</dd></div>
        <div><dt>${labels.boundaryLabel}</dt><dd>${labels.boundary}</dd></div>
      </dl>
      <nav class="hero-actions" aria-label="${labels.footerLabel}">
        <a class="case-link case-link--primary" href="#recruiter-summary" data-case-anchor="recruiter-summary">${labels.quickReadAction}</a>
        <a class="case-link" href="#${resources.fullCaseAnchor}" data-case-anchor="${resources.fullCaseAnchor}">${labels.fullCaseAction}</a>
        <a class="case-link" href="${resources.pdf[lang]}">${labels.pdfAction}</a>
        <a class="case-link case-link--text" href="${resources.github}" rel="noreferrer">${labels.githubAction}</a>
      </nav>
      <p class="hero-footnote">${escapeHtml(
        quickRead?.summary
        || (lang === "zh"
          ? "一份关于定位、取舍、AI 行为与证据边界的独立产品记录"
          : "An independent product record of positioning, trade-offs, AI behavior, and evidence boundaries")
      )}</p>
    </section>
  `;
}
```

- [ ] **Step 6: Add the quick-read and footer renderers**

Add before `renderSection`:

```js
function evidencePill(label, text) {
  return `
    <div class="boundary-card">
      <strong>${escapeHtml(label)}</strong>
      <p>${escapeHtml(text)}</p>
    </div>
  `;
}

function renderRecruiterFallback(lang) {
  console.error("Missing recruiter quick-read content.", { lang });
  return `
    <section class="recruiter-summary recruiter-summary--fallback" id="recruiter-summary">
      <p>${lang === "zh"
        ? "招聘速览暂时不可用，请继续阅读下方完整案例。"
        : "The recruiter overview is temporarily unavailable. Continue with the full case study below."}</p>
    </section>
  `;
}

function renderQuickRead(quickRead, lang) {
  if (!quickRead) return renderRecruiterFallback(lang);
  const labels = LANGUAGE_CONFIG[lang];
  return `
    <section class="recruiter-summary" id="recruiter-summary" aria-labelledby="quick-read-title">
      <p class="eyebrow">${escapeHtml(quickRead.label)}</p>
      <h2 id="quick-read-title">${escapeHtml(quickRead.title)}</h2>
      <div class="quick-read-grid">
        <article class="quick-read-problem">
          <p class="section-index">01 / PROBLEM</p>
          <h3>${escapeHtml(quickRead.problem.title)}</h3>
          <p>${escapeHtml(quickRead.problem.body)}</p>
        </article>
        <article class="quick-read-decisions">
          <p class="section-index">02 / DECISIONS</p>
          <div class="decision-grid">
            ${quickRead.decisions.map((decision, index) => `
              <section>
                <span>${String(index + 1).padStart(2, "0")}</span>
                <h3>${escapeHtml(decision.title)}</h3>
                <p>${escapeHtml(decision.body)}</p>
                <p class="decision-evidence">${decision.evidenceIds
                  .map((id) => `<span class="evidence-id">${escapeHtml(id)}</span>`)
                  .join("")}</p>
              </section>
            `).join("")}
          </div>
        </article>
        <article class="quick-read-delivery">
          <p class="section-index">03 / DELIVERY</p>
          <h3>${escapeHtml(quickRead.delivery.title)}</h3>
          <p>${escapeHtml(quickRead.delivery.body)}</p>
          <ul>${quickRead.delivery.items
            .map((item) => `<li>${escapeHtml(item)}</li>`)
            .join("")}</ul>
        </article>
        <article class="quick-read-evidence">
          <p class="section-index">04 / EVIDENCE</p>
          <h3>${escapeHtml(quickRead.evidence.title)}</h3>
          <p>${escapeHtml(quickRead.evidence.body)}</p>
          <div class="boundary-grid">
            ${evidencePill("Implemented", quickRead.evidence.implemented)}
            ${evidencePill("Scenario-validated", quickRead.evidence.scenarioValidated)}
            ${evidencePill("Hypothesis", quickRead.evidence.hypothesis)}
          </div>
        </article>
      </div>
      <p class="quick-read-end">
        <a class="case-link case-link--text" href="#overview" data-case-anchor="overview">${labels.fullCaseAction}</a>
      </p>
    </section>
  `;
}

function renderFooter(resources, lang) {
  const labels = LANGUAGE_CONFIG[lang];
  return `
    <p class="eyebrow">${labels.footerLabel}</p>
    <div class="footer-links">
      <a class="case-link" href="${resources.pdf.zh}">中文 PDF</a>
      <a class="case-link" href="${resources.pdf.en}">English PDF</a>
      <a class="case-link case-link--text" href="${resources.github}" rel="noreferrer">${labels.githubAction}</a>
    </div>
  `;
}
```

- [ ] **Step 7: Integrate rendering and internal anchor behavior**

Add:

```js
const footerNode = document.querySelector("#case-study-footer");

function bindPageAnchors() {
  for (const link of document.querySelectorAll("[data-case-anchor]")) {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      scrollToSection(link.dataset.caseAnchor);
    });
  }
}
```

Replace the start of `renderLanguage(lang)` with:

```js
function renderLanguage(lang) {
  const { meta, quickRead, sections } = caseStudyContent[lang];
  const { resources } = caseStudyContent;
  document.documentElement.lang = LANGUAGE_CONFIG[lang].htmlLang;
  document.documentElement.dataset.activeLanguage = lang;
  contentNode.innerHTML = renderHero(meta, quickRead, resources, lang)
    + renderQuickRead(quickRead, lang)
    + sections.map((section, index) => renderSection(section, index, lang)).join("");
  footerNode.innerHTML = renderFooter(resources, lang);
  renderNav(sections, lang);
  bindNavigation();
  bindPageAnchors();
  for (const button of languageButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.language === lang));
  }
}
```

Keep `currentSectionAnchor()` limited to `[data-section]`; the quick read is not an eleventh chapter.

- [ ] **Step 8: Add the approved editorial styles**

Add before `.case-section` in `case-study/web/styles.css`:

```css
.hero-actions,
.footer-links {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 28px;
}

.case-link {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 10px 15px;
  border: 1px solid var(--rule);
  color: var(--ink);
  background: var(--paper-raised);
  text-decoration: none;
  font-family: var(--sans);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.case-link:hover,
.case-link:focus-visible {
  border-color: var(--terracotta);
  color: var(--terracotta);
}

.case-link--primary {
  color: var(--paper-raised);
  background: var(--terracotta);
  border-color: var(--terracotta);
}

.case-link--primary:hover,
.case-link--primary:focus-visible {
  color: var(--paper-raised);
  background: var(--terracotta);
  opacity: 0.88;
}

.case-link--text {
  background: transparent;
}

.pre-render-link {
  position: absolute;
  left: -9999px;
}

.recruiter-summary {
  padding: 76px 0;
  border-top: 1px solid var(--rule);
  scroll-margin-top: 96px;
}

.recruiter-summary > h2 {
  max-width: 780px;
  margin: 8px 0 30px;
  font-family: var(--serif);
  font-size: clamp(36px, 5vw, 64px);
  line-height: 1.04;
  text-wrap: balance;
}

.quick-read-grid {
  display: grid;
  gap: 44px;
}

.quick-read-grid article {
  padding-top: 22px;
  border-top: 1px solid var(--rule);
}

.quick-read-grid h3 {
  max-width: 780px;
  margin: 8px 0 14px;
  font-family: var(--serif);
  font-size: clamp(24px, 3vw, 38px);
  line-height: 1.14;
}

.quick-read-grid p,
.quick-read-grid li {
  max-width: 780px;
  font-size: 17px;
  line-height: 1.8;
}

.decision-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}

.decision-grid > section,
.boundary-card {
  min-width: 0;
  padding: 20px;
  background: var(--paper-raised);
  border: 1px solid var(--rule);
}

.decision-grid > section > span {
  color: var(--terracotta);
  font-family: var(--sans);
  font-size: 12px;
}

.decision-grid h3 {
  font-size: 24px;
}

.decision-grid p {
  font-size: 15px;
}

.decision-evidence {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.boundary-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
  margin-top: 20px;
}

.boundary-card strong {
  color: var(--terracotta);
  font-family: var(--sans);
  font-size: 12px;
}

.boundary-card p {
  margin-bottom: 0;
  font-size: 14px;
}

.quick-read-end {
  margin-top: 28px;
}

.case-study-footer {
  margin-left: min(24vw, 310px);
  padding: 48px clamp(24px, 6vw, 96px) 72px;
  border-top: 1px solid var(--rule);
}
```

Inside `@media (max-width: 860px)`, add:

```css
  .hero-actions,
  .footer-links {
    display: grid;
    grid-template-columns: 1fr;
  }

  .decision-grid,
  .boundary-grid {
    grid-template-columns: 1fr;
  }

  .recruiter-summary {
    padding: 54px 0;
  }

  .case-study-footer {
    margin-left: 0;
    padding: 36px 18px 56px;
  }
```

- [ ] **Step 9: Run the web contract and verify GREEN**

Run:

```powershell
node --test test/caseStudyWeb.test.js
```

Expected: all web tests PASS; no external runtime dependency or `scrollIntoView` is introduced.

- [ ] **Step 10: Commit Task 3**

```powershell
git add case-study/web/index.html case-study/web/case-study.js case-study/web/styles.css test/caseStudyWeb.test.js
git commit -m "feat: add recruiter quick-read experience"
```

---

### Task 4: Enforce PDF delivery and update the review record

**Files:**
- Modify: `test/caseStudyAssets.test.js`
- Modify: `case-study/REVIEW.md`

**Interfaces:**
- Consumes: the checked-in PDF files.
- Produces: a resource contract requiring both PDFs to remain present and non-empty.
- Produces: a review record separating original Case Study evidence from recruiter-edition validation.

- [ ] **Step 1: Add a characterization test for the existing PDF prerequisites**

Append to `test/caseStudyAssets.test.js`:

```js
test("recruiter delivery includes both non-empty PDF editions", () => {
  for (const name of [
    "margin-case-study.zh.pdf",
    "margin-case-study.en.pdf"
  ]) {
    const path = new URL(`../case-study/dist/${name}`, import.meta.url);
    const buffer = fs.readFileSync(path);
    assert.ok(buffer.length > 1_000_000, `${name} is missing or unexpectedly small`);
    assert.equal(buffer.toString("ascii", 0, 4), "%PDF");
  }
});
```

This characterization test is expected to pass because the two PDFs are existing prerequisites, not newly implemented behavior. The new delivery-link behavior received its RED proof in Task 3 before the links were added.

- [ ] **Step 2: Run the resource and web tests**

Run:

```powershell
node --test test/caseStudyAssets.test.js test/caseStudyWeb.test.js
```

Expected: PDF resource assertions PASS and the completed Task 3 web delivery assertions PASS.

- [ ] **Step 3: Update the review record**

Append this section to `case-study/REVIEW.md`, replacing the numeric test totals with the actual totals observed during execution:

```markdown
## Recruiter delivery edition — 2026-07-29

- Added bilingual recruiter quick read before the existing ten chapters.
- Added current-language PDF, full-case, and GitHub actions in the hero.
- Added both PDF editions and GitHub actions in the footer.
- Added Chinese resume and interview material without raising any evidence classification.
- Recruiter content contract: passed.
- Case Study tests: passed; exact total recorded from the final command.
- Echo full test suite: passed; exact total recorded from the final command.
- Privacy scan: passed with zero findings.
- Desktop browser review: 1440×1000, Chinese and English.
- Mobile browser review: 390×844, Chinese and English, no horizontal overflow.
- External user validation remains pending.
```

- [ ] **Step 4: Run privacy and focused tests**

Run:

```powershell
node scripts/case-study/check-privacy.mjs case-study
node --test test/caseStudyAssets.test.js test/caseStudyContentContract.test.js test/caseStudyWeb.test.js
```

Expected: privacy scan passes with zero findings and all focused tests PASS.

- [ ] **Step 5: Commit Task 4**

```powershell
git add test/caseStudyAssets.test.js case-study/REVIEW.md
git commit -m "test: verify recruiter delivery assets"
```

---

### Task 5: Perform browser QA and full regression

**Files:**
- Modify only if a failing browser case first receives a reproducing test.
- Verify: `case-study/web/index.html`
- Verify: `case-study/REVIEW.md`

**Interfaces:**
- Consumes: the completed static page and tests.
- Produces: verified desktop/mobile layout and final test totals.

- [ ] **Step 1: Start a local static server**

Run:

```powershell
$server = Start-Process `
  -FilePath 'python' `
  -ArgumentList '-m','http.server','8765','--bind','127.0.0.1','--directory','case-study' `
  -PassThru `
  -WindowStyle Hidden
$server.Id | Set-Content -LiteralPath 'C:\Temp\margin-recruiter-http-server.pid' -Encoding ascii
```

Expected: server listens on `http://127.0.0.1:8765/` and the root redirect opens `web/index.html`.

- [ ] **Step 2: Review the desktop page**

Open:

```text
http://127.0.0.1:8765/web/index.html
```

Set the viewport to 1440×1000 and verify:

```text
- title, role, stage, and boundary are visible;
- all four hero actions are visible and keyboard reachable;
- quick read has exactly three decisions;
- the evidence boundary shows all three evidence levels;
- Chinese and English modes preserve the same structure;
- “查看完整案例 / Read full case study” lands on overview;
- both PDF links open a PDF;
- GitHub opens https://github.com/YJ-Q/Echo;
- the existing ten chapters and evidence visuals remain intact.
```

- [ ] **Step 3: Review the mobile page**

Set the browser device viewport to exactly 390×844 and run in DevTools console:

```js
({
  innerWidth,
  innerHeight,
  rootWidth: document.documentElement.scrollWidth,
  bodyWidth: document.body.scrollWidth,
  title: document.querySelector("h1").getBoundingClientRect(),
  actions: [...document.querySelectorAll(".hero-actions .case-link")]
    .map((node) => node.getBoundingClientRect())
})
```

Expected:

```text
innerWidth === 390
innerHeight === 844
rootWidth === 390
bodyWidth === 390
every action height >= 44
no title or action rectangle extends beyond x=0..390
```

Repeat after switching to English.

After browser QA, stop only the server process recorded by this task:

```powershell
$serverPid = [int](Get-Content -Raw -LiteralPath 'C:\Temp\margin-recruiter-http-server.pid')
Stop-Process -Id $serverPid
Remove-Item -LiteralPath 'C:\Temp\margin-recruiter-http-server.pid'
```

- [ ] **Step 4: If visual QA finds a defect, reproduce it before fixing**

For horizontal overflow, add this exact assertion to `test/caseStudyWeb.test.js` before changing CSS:

```js
assert.match(
  css,
  /@media\s*\(max-width:\s*860px\)[\s\S]*?\.decision-grid,[\s\S]*?\.boundary-grid\s*\{[^}]*grid-template-columns:\s*1fr/s
);
```

Run the focused test, verify it fails for the observed defect, make the minimal CSS correction, and rerun until green.

- [ ] **Step 5: Run final static checks**

Run:

```powershell
node scripts/case-study/check-privacy.mjs case-study
node --check scripts/case-study/build-web.mjs
node --check scripts/case-study/lib/content-contract.mjs
node --check case-study/web/case-study.js
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 6: Run focused and full regression**

Run:

```powershell
node --test test/caseStudyAssets.test.js test/caseStudyContentContract.test.js test/caseStudyPdf.test.js test/caseStudyPrivacy.test.js test/caseStudyWeb.test.js
npm test
```

Expected: all focused Case Study tests and all Echo tests PASS. Record the exact totals in `case-study/REVIEW.md`, rerun `git diff --check`, then commit the numerical review update:

```powershell
git add case-study/REVIEW.md
git commit -m "docs: record recruiter delivery verification"
```

---

### Task 6: Update and redeploy the existing Coze project

**Files:**
- Create temporarily outside Git: `C:\Temp\margin-recruiter-delivery\`
- Create temporarily outside Git: `C:\Temp\margin-recruiter-delivery.zip`
- Do not modify tracked source files.

**Interfaces:**
- Consumes: verified `case-study/index.html`, `case-study/web/`, `case-study/assets/`, and `case-study/dist/`.
- Updates: the configured Coze project (`<COZE_PROJECT_ID>`).
- Produces: a `Succeeded` deployment and public URL.

- [ ] **Step 1: Confirm Coze authentication**

Run:

```powershell
node -e "global.navigator={}; process.argv=['node','coze','auth','status','--format','json']; require('<USER_HOME>/AppData/Roaming/npm/node_modules/@coze/cli/bin/main')"
```

Expected: JSON contains `"logged_in": true`. If false, stop and complete `coze auth login` before continuing.

- [ ] **Step 2: Build a minimal verified deployment ZIP**

Run:

```powershell
$stage='C:\Temp\margin-recruiter-delivery'
$zip='C:\Temp\margin-recruiter-delivery.zip'
if ((Test-Path -LiteralPath $stage) -or (Test-Path -LiteralPath $zip)) {
  throw 'Deployment staging target already exists; refusing to overwrite.'
}
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item -LiteralPath 'case-study\index.html' -Destination $stage
Copy-Item -LiteralPath 'case-study\web' -Destination $stage -Recurse
Copy-Item -LiteralPath 'case-study\assets' -Destination $stage -Recurse
Copy-Item -LiteralPath 'case-study\dist' -Destination $stage -Recurse
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
Get-Item -LiteralPath $zip | Select-Object FullName,Length
```

Expected: ZIP exists, is below 500 MB, and contains root `index.html`, `web`, `assets`, and `dist`.

- [ ] **Step 3: Send the verified update to the existing Coze project**

Run:

```powershell
node -e "global.navigator={}; process.argv=['node','coze','code','message','send','使用附件 @C:/Temp/margin-recruiter-delivery.zip 更新现有静态 Case Study。保留现有文案、视觉和十章正文；用附件完整替换站点静态资源，确保根路径、双语速览、两个 PDF 和 GitHub 链接可用。','-p','<COZE_PROJECT_ID>','--format','json']; require('<USER_HOME>/AppData/Roaming/npm/node_modules/@coze/cli/bin/main')"
```

Expected: JSON reports `"status": "sent"` and the same project ID.

- [ ] **Step 4: Poll initialization with bounded single checks**

Run one status query per check:

```powershell
node -e "global.navigator={}; process.argv=['node','coze','code','message','status','-p','<COZE_PROJECT_ID>','--format','json']; require('<USER_HOME>/AppData/Roaming/npm/node_modules/@coze/cli/bin/main')"
```

Expected progression: `processing` → `done`. Do not deploy while the status is not `done`. Do not put an unbounded sleep loop in one shell call.

- [ ] **Step 5: Trigger production deployment**

Run only after message status is `done`:

```powershell
$deployRaw = node -e "global.navigator={}; process.argv=['node','coze','code','deploy','<COZE_PROJECT_ID>','--format','json']; require('<USER_HOME>/AppData/Roaming/npm/node_modules/@coze/cli/bin/main')"
$deploy = $deployRaw | ConvertFrom-Json
if (-not $deploy.deployHistoryId) {
  throw 'Coze deploy did not return deployHistoryId.'
}
$deploy | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath 'C:\Temp\margin-recruiter-deploy.json' -Encoding UTF8
$deploy
```

Expected: the printed object contains a `deployHistoryId` and status `Pending` or `Running`; the exact response is saved to `C:\Temp\margin-recruiter-deploy.json`.

- [ ] **Step 6: Check deployment to terminal status**

Run one status query per check:

```powershell
$deploy = Get-Content -Raw -LiteralPath 'C:\Temp\margin-recruiter-deploy.json' | ConvertFrom-Json
$deployId = [string]$deploy.deployHistoryId
$statusRaw = node -e "global.navigator={}; process.argv=['node','coze','code','deploy','status','<COZE_PROJECT_ID>','--deploy-id','$deployId','--format','json']; require('<USER_HOME>/AppData/Roaming/npm/node_modules/@coze/cli/bin/main')"
$status = $statusRaw | ConvertFrom-Json
$status | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath 'C:\Temp\margin-recruiter-deploy-status.json' -Encoding UTF8
$status
```

Expected: `Succeeded` and a non-empty `domain`. `Failed` or `Canceled` is a terminal failure and must be reported; do not claim success. If the result is still `Pending` or `Running`, repeat this single status step later instead of adding an unbounded loop.

- [ ] **Step 7: Verify public resources**

For the returned domain, run:

```powershell
$status = Get-Content -Raw -LiteralPath 'C:\Temp\margin-recruiter-deploy-status.json' | ConvertFrom-Json
$base = [string]$status.domain
if ($status.status -ne 'Succeeded' -or -not $base) {
  throw 'Deployment is not succeeded or has no public domain.'
}
$urls=@(
  "$base/",
  "$base/web/index.html",
  "$base/web/case-study.js",
  "$base/dist/margin-case-study.zh.pdf",
  "$base/dist/margin-case-study.en.pdf",
  "$base/assets/screenshots/now.png"
)
$results=foreach($url in $urls) {
  $response=Invoke-WebRequest -Uri $url -Method Head -UseBasicParsing -MaximumRedirection 5
  [pscustomobject]@{
    Url=$url
    Status=[int]$response.StatusCode
    ContentType=$response.Headers['Content-Type']
  }
}
$results | Format-Table -AutoSize
```

Expected: every status is 200; HTML, JavaScript, PDF, and PNG content types match their resource classes.

- [ ] **Step 8: Remove only the verified temporary deployment files**

Run:

```powershell
$stage='C:\Temp\margin-recruiter-delivery'
$zip='C:\Temp\margin-recruiter-delivery.zip'
$deployRecord='C:\Temp\margin-recruiter-deploy.json'
$statusRecord='C:\Temp\margin-recruiter-deploy-status.json'
$resolvedStage=(Resolve-Path -LiteralPath $stage).Path
$resolvedZip=(Resolve-Path -LiteralPath $zip).Path
if ($resolvedStage -cne $stage -or $resolvedZip -cne $zip) {
  throw 'Unexpected deployment cleanup target.'
}
Remove-Item -LiteralPath $resolvedStage -Recurse -Force
Remove-Item -LiteralPath $resolvedZip -Force
Remove-Item -LiteralPath $deployRecord -Force
Remove-Item -LiteralPath $statusRecord -Force
```

Expected: all four temporary paths are absent; tracked source remains unchanged.

- [ ] **Step 9: Final handoff**

Report:

```text
- public Case Study URL;
- Coze project URL;
- branch and final commit;
- focused and full test totals;
- privacy-scan result;
- desktop/mobile QA result;
- HTTP status for root, both PDFs, script, and representative image;
- explicit note that external user validation remains pending.
```

If the implementation branch is not yet integrated, use `finishing-a-development-branch` to present merge, PR, keep, or discard options without touching unrelated main-worktree changes.
