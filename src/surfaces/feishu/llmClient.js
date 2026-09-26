import https from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';

let _proxyAgent = null;
function getProxyAgent() {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (!proxyUrl) return null;
  if (_proxyAgent) return _proxyAgent;
  _proxyAgent = new HttpsProxyAgent(proxyUrl);
  return _proxyAgent;
}

export async function summarizeNewsItems(items, { apiKey, modelId = 'deepseek-ai/DeepSeek-V3' } = {}) {
  if (!apiKey) throw new Error('llm_client_missing_api_key');
  if (!items || items.length === 0) return [];

  const itemsText = items.map((item, i) =>
    `[${i + 1}] 标题: ${item.title}\n来源: ${item.source || '未知'}\n内容: ${item.snippet || item.summary || item.description || '无'}`
  ).join('\n\n');

  const prompt = `你是我的 AI 技术助理。我是一名 AI 应用开发者，关注 LLM 产品落地、Agent 框架、开发工具和行业动态。

请对以下每条新闻写一句**中文**解读（25-40字），说明对开发者的实际价值或值得关注的原因。
要求：
- 必须全部用中文
- 不重复标题内容，直接说价值点
- 如果原文是英文，翻译核心信息后再解读

格式：每条用 [编号] 开头，一行内完成，不加其他内容。

新闻列表：
${itemsText}`;

  const requestBody = JSON.stringify({
    model: modelId,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 2000,
    temperature: 0.5
  });

  const responseText = await callSiliconFlow(requestBody, apiKey);
  return parseSummaries(responseText, items.length);
}

export async function analyzeInterview(transcript, { apiKey, modelId = 'deepseek-ai/DeepSeek-V3' } = {}) {
  if (!apiKey) throw new Error('llm_client_missing_api_key');

  const prompt = `你是一位面试复盘专家。请分析以下面试对话，返回严格的 JSON 格式结果。

面试录音稿：
${transcript}

请返回以下 JSON 结构（不要加任何多余文字，只返回 JSON）：
{
  "interview_type": "技术面|主管面|HR面|综合面",
  "company": "公司名，如无法判断填空字符串",
  "role": "岗位名，如无法判断填空字符串",
  "round": "几面，如一面/二面/终面，如无法判断填一面",
  "overall_assessment": "整体表现一句话总结",
  "questions": [
    {
      "question": "面试官的问题原文",
      "my_answer": "我的回答摘要",
      "score": "good|bad|ok",
      "issue": "如果score是bad或ok，指出问题所在，good时填空字符串",
      "improvement": "如果score是bad或ok，给出改进建议，good时填空字符串"
    }
  ],
  "frequent_topics": ["高频考点1", "高频考点2"]
}

评分标准：good=回答完整有亮点；ok=基本回答但不够深入；bad=回答有明显问题或遗漏`;

  const requestBody = JSON.stringify({
    model: modelId,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 4000,
    temperature: 0.3
  });

  const responseText = await callSiliconFlow(requestBody, apiKey);

  try {
    const cleaned = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    throw new Error(`interview_analysis_parse_failed: ${responseText.slice(0, 200)}`);
  }
}

function callSiliconFlow(body, apiKey) {
  return new Promise((resolve, reject) => {
    const agent = getProxyAgent();
    const options = {
      hostname: 'api.siliconflow.cn',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body)
      },
      agent
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          const content = parsed.choices?.[0]?.message?.content;
          if (!content) reject(new Error(`llm_empty_response: ${raw}`));
          else resolve(content);
        } catch {
          reject(new Error(`llm_parse_failed: ${raw}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('llm_timeout')); });
    req.write(body);
    req.end();
  });
}

function parseSummaries(text, count) {
  const summaries = new Array(count).fill('');
  const lines = text.split('\n').filter(l => l.trim());

  let current = -1;
  let buffer = [];

  for (const line of lines) {
    const match = line.match(/^\[(\d+)\]/);
    if (match) {
      if (current >= 0 && current < count) {
        summaries[current] = buffer.join(' ').trim();
      }
      current = parseInt(match[1], 10) - 1;
      buffer = [line.replace(/^\[\d+\]\s*/, '').trim()];
    } else if (current >= 0) {
      buffer.push(line.trim());
    }
  }
  if (current >= 0 && current < count) {
    summaries[current] = buffer.join(' ').trim();
  }

  return summaries;
}
