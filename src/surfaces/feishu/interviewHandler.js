import { analyzeInterview } from './llmClient.js';
import { markdownToBlocks } from './feishuDocClient.js';

export function createInterviewHandler({ feishuDocClient, jobStore, apiKey }) {

  // ── 主入口：处理录音稿 ────────────────────────────────────────────────────

  async function handleTranscript({ transcript, company, role, round }) {
    // 1. LLM 分析
    const analysis = await analyzeInterview(transcript, { apiKey });

    // 合并参数和 LLM 推断值
    const finalCompany = company || analysis.company || '未知公司';
    const finalRole = role || analysis.role || '未知岗位';
    const finalRound = round || analysis.round || '一面';
    const interviewType = analysis.interview_type || '综合面';

    // 2. 生成文档 Markdown
    const markdown = buildReviewMarkdown({ analysis, company: finalCompany, role: finalRole, round: finalRound, interviewType });

    // 3. 获取面试复盘文件夹 token
    const interviewsFolderToken = await jobStore.getFolder('interviews');
    if (!interviewsFolderToken) throw new Error('面试复盘文件夹未初始化，请先运行 setup');

    // 4. 创建飞书文档
    const dateStr = new Date().toISOString().slice(0, 10);
    const docTitle = `${dateStr}_${finalCompany}_${finalRole}_${finalRound}_${interviewType}`;
    const { documentId, url } = await feishuDocClient.createDoc({
      folderToken: interviewsFolderToken,
      title: docTitle
    });

    // 5. 写入内容
    await feishuDocClient.appendMarkdown({ documentId, markdown });

    // 6. 更新高频题库
    if (analysis.frequent_topics?.length > 0) {
      await updateFrequentTopics({ role: finalRole, topics: analysis.frequent_topics, questions: analysis.questions });
    }

    // 7. 本地记录
    let app = await jobStore.findApplication({ company: finalCompany, role: finalRole });
    if (!app) {
      app = await jobStore.addApplication({ company: finalCompany, role: finalRole });
    }
    await jobStore.addInterview({
      applicationId: app.id,
      round: finalRound,
      feishuDocId: documentId,
      summary: analysis.overall_assessment || ''
    });

    return { documentId, url, docTitle, analysis, company: finalCompany, role: finalRole, round: finalRound, interviewType };
  }

  // ── 高频题库更新 ──────────────────────────────────────────────────────────

  async function updateFrequentTopics({ role, topics, questions }) {
    const faqFolderToken = await jobStore.getFolder('faq');
    if (!faqFolderToken) return; // 未初始化则跳过

    // 通用题库
    const badQuestions = questions.filter(q => q.score === 'bad' || q.score === 'ok');
    if (badQuestions.length > 0) {
      const commonDocId = await getOrCreateFaqDoc({ folderToken: faqFolderToken, title: '通用问题' });
      const md = buildFaqAppend({ questions: badQuestions, role, topics });
      await feishuDocClient.appendMarkdown({ documentId: commonDocId, markdown: md });
    }

    // 岗位专属题库
    if (role) {
      const roleDocId = await getOrCreateFaqDoc({ folderToken: faqFolderToken, title: `${role}_高频问题` });
      const md = buildFaqAppend({ questions: badQuestions, role, topics });
      await feishuDocClient.appendMarkdown({ documentId: roleDocId, markdown: md });
    }
  }

  async function getOrCreateFaqDoc({ folderToken, title }) {
    const existing = await jobStore.listDocIndex('faq');
    const found = existing.find(d => d.title === title);
    if (found) return found.feishu_doc_id;
    const { documentId, url } = await feishuDocClient.createDoc({ folderToken, title });
    await jobStore.upsertDocIndex({ docType: 'faq', title, feishuDocId: documentId, feishuUrl: url, folderToken });
    return documentId;
  }

  return { handleTranscript };
}

// ── Markdown 生成 ────────────────────────────────────────────────────────────

function buildReviewMarkdown({ analysis, company, role, round, interviewType }) {
  const date = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const lines = [];

  lines.push(`# ${company} · ${role} · ${round}（${interviewType}）· ${date}`);
  lines.push('');
  lines.push('## 基本信息');
  lines.push(`- **公司**：${company}`);
  lines.push(`- **岗位**：${role}`);
  lines.push(`- **轮次**：${round}`);
  lines.push(`- **类型**：${interviewType}`);
  lines.push(`- **日期**：${date}`);
  lines.push('');
  lines.push('## 整体评价');
  lines.push(analysis.overall_assessment || '');
  lines.push('');
  lines.push('---');

  const bad = (analysis.questions || []).filter(q => q.score === 'bad' || q.score === 'ok');
  const good = (analysis.questions || []).filter(q => q.score === 'good');

  if (bad.length > 0) {
    lines.push('');
    lines.push('## 待改进（优先复习）');
    for (const q of bad) {
      lines.push('');
      lines.push(`### Q：${q.question}`);
      lines.push(`**我的回答**：${q.my_answer}`);
      lines.push(`**问题所在**：${q.issue}`);
      lines.push(`**下次怎么答**：${q.improvement}`);
    }
  }

  if (good.length > 0) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## 表现不错');
    for (const q of good) {
      lines.push('');
      lines.push(`### Q：${q.question}`);
      lines.push(`**我的回答**：${q.my_answer}`);
    }
  }

  if (analysis.frequent_topics?.length > 0) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## 本次高频考点');
    for (const t of analysis.frequent_topics) {
      lines.push(`- ${t}`);
    }
  }

  return lines.join('\n');
}

function buildFaqAppend({ questions, role, topics }) {
  const date = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const lines = [];
  lines.push(`## ${date}${role ? `（${role}）` : ''} 新增`);
  lines.push('');

  if (topics?.length > 0) {
    lines.push(`**考点**：${topics.join('、')}`);
    lines.push('');
  }

  for (const q of questions) {
    lines.push(`- **${q.question}**`);
    if (q.improvement) lines.push(`  → ${q.improvement}`);
  }

  lines.push('');
  lines.push('---');
  return lines.join('\n');
}
