import { fetchAllNews } from './newsFetcher.js';
import { summarizeNewsItems } from './llmClient.js';

export async function buildMorningBrief({ gateway, newsOptions = {}, feishuClient, receiveId, receiveIdType = 'open_id' } = {}) {
  const now = new Date();
  const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const dayStr = `周${weekdays[now.getDay()]}`;

  const elements = [];

  // ── 工作流状态 ──────────────────────────────────────────────
  if (gateway) {
    const workstreamSection = await buildWorkstreamSection(gateway);
    if (workstreamSection) elements.push(...workstreamSection);
  }

  // ── 新闻摘要 ──────────────────────────────────────────────
  const newsSection = await buildNewsSection(newsOptions);
  if (newsSection) elements.push(...newsSection);

  if (elements.length === 0) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: '今日暂无内容。' }
    });
  }

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `${dateStr} ${dayStr} · 早报` },
      template: 'white'
    },
    elements
  };

  if (feishuClient && receiveId) {
    await feishuClient.sendMessage({
      receiveId,
      receiveIdType,
      msgType: 'interactive',
      content: card
    });
    return { sent: true };
  }

  return card;
}

async function buildWorkstreamSection(gateway) {
  try {
    const result = await gateway.query({ type: 'listWorkstreams' });
    const workstreams = result?.data ?? result ?? [];
    if (!Array.isArray(workstreams) || workstreams.length === 0) return null;

    const active = workstreams.filter(w => w.status === 'active' && w.nextAction);
    const needsOwner = workstreams.filter(w => w.status === 'needs_owner');

    if (active.length === 0 && needsOwner.length === 0) return null;

    const elements = [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: '**📋 工作流进展**' }
      }
    ];

    for (const w of active) {
      let text = `**${w.name}**\n→ ${w.nextAction}`;
      if (w.blockers) text += `\n⚠️ 阻塞：${w.blockers}`;
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: text } });
    }

    if (needsOwner.length > 0) {
      const list = needsOwner.map(w => `• ${w.name}`).join('\n');
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `**待认领**\n${list}` }
      });
    }

    elements.push({ tag: 'hr' });
    return elements;
  } catch {
    return null;
  }
}

async function buildNewsSection(newsOptions) {
  const { smolLimit = 3, hfLimit = 4, arxivLimit = 2, batchLimit = 2, simonLimit = 2, latentLimit = 2 } = newsOptions;
  const apiKey = process.env.SILICONFLOW_API_KEY;

  let allItems = [];
  const fetchErrors = [];

  try {
    const news = await fetchAllNews({ smolLimit, hfLimit, arxivLimit, batchLimit, simonLimit, latentLimit });

    const sources = [
      { key: 'smol', label: 'smol.ai' },
      { key: 'huggingface', label: 'HuggingFace' },
      { key: 'arxiv', label: 'arXiv' },
      { key: 'batch', label: 'TechCrunch AI' },
      { key: 'simon', label: 'Simon Willison' },
      { key: 'latent', label: 'Latent Space' }
    ];

    for (const { key, label } of sources) {
      const s = news[key];
      if (s?.items?.length > 0) allItems.push(...s.items.map(i => ({ ...i, source: label })));
      else if (s?.ok === false) fetchErrors.push(`${label}: ${s.error ?? 'fetch_failed'}`);
    }
  } catch (err) {
    console.error('[brief] news fetch error:', err.message);
    fetchErrors.push(err.message);
  }

  if (fetchErrors.length > 0) console.error('[brief] fetch errors:', fetchErrors.join('; '));

  if (allItems.length === 0) {
    const errText = fetchErrors.length > 0
      ? `新闻抓取失败：${fetchErrors.join('；')}`
      : '今日新闻暂时无法获取，请稍后手动触发 /brief 重试。';
    return [{ tag: 'div', text: { tag: 'lark_md', content: `**🔬 今日 AI 动态**\n${errText}` } }];
  }

  // Normalize items: clean up text, extract best available snippet
  const normalized = allItems.map(item => ({
    ...item,
    displayTitle: normalizeTitle(item),
    snippet: extractSnippet(item)
  }));

  // Filter: skip items with no real content
  const filtered = normalized.filter(item => item.displayTitle.length > 10);

  // All items go through LLM for Chinese summary — snippets are used as context
  let summaries = filtered.map(item => item.snippet);
  if (apiKey) {
    try {
      summaries = await summarizeNewsItems(filtered, { apiKey });
    } catch (err) {
      console.error('[brief] llm summarize error:', err.message);
    }
  }

  const elements = [
    { tag: 'div', text: { tag: 'lark_md', content: '**🔬 今日 AI 动态**' } }
  ];

  for (let i = 0; i < filtered.length; i++) {
    const item = filtered[i];
    const summary = summaries[i] || '';
    const link = item.link || item.url || '';

    // Compact single-block format: source tag + title + one-line summary
    let content = `**[${item.source}]** `;
    if (link) {
      content += `[${item.displayTitle}](${link})`;
    } else {
      content += item.displayTitle;
    }
    if (summary) content += `\n${summary}`;

    elements.push({ tag: 'div', text: { tag: 'lark_md', content } });
  }

  return elements;
}

function normalizeTitle(item) {
  const title = item.title || '';
  // smol.ai uses generic titles — use first sentence of description instead
  if (item.source === 'smol.ai' && (title.toLowerCase().includes('not much') || title.toLowerCase().includes('big day'))) {
    const desc = cleanText(item.description || '');
    // Extract first meaningful segment (up to first period or 80 chars)
    const firstSentence = desc.match(/^(.{20,80}?)[.!?]/)?.[1] || desc.slice(0, 80);
    return firstSentence.trim() || title;
  }
  return title.trim();
}

function extractSnippet(item) {
  const raw = item.description || item.summary || '';
  if (!raw) return '';
  const cleaned = cleanText(raw);
  // For smol.ai, the description IS the content — use more of it
  const limit = item.source === 'smol.ai' ? 120 : 80;
  return cleaned.length > limit ? cleaned.slice(0, limit) + '…' : cleaned;
}

function cleanText(str) {
  if (!str) return '';
  return str
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")
    .replace(/\*\*/g, '').replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ').trim();
}
