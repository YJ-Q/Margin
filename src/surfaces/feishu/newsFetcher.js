import https from 'node:https';
import http from 'node:http';

let _proxyAgent = null;
async function getProxyAgent() {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
  if (!proxyUrl) return null;
  if (_proxyAgent) return _proxyAgent;
  try {
    const { HttpsProxyAgent } = await import('https-proxy-agent');
    _proxyAgent = new HttpsProxyAgent(proxyUrl);
    return _proxyAgent;
  } catch { return null; }
}

async function fetchUrl(url, { timeoutMs = 15_000, redirects = 5 } = {}) {
  if (redirects <= 0) throw new Error('too_many_redirects');
  const targetUrl = new URL(url);
  const isHttps = targetUrl.protocol === 'https:';
  const agent = isHttps ? await getProxyAgent() : null;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: targetUrl.hostname,
      port: Number(targetUrl.port) || (isHttps ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method: 'GET',
      timeout: timeoutMs,
      headers: { 'User-Agent': 'margin-agent/1.0', 'Accept': 'application/json, text/xml, */*' },
      ...(agent ? { agent } : {})
    };

    const client = isHttps ? https : http;
    const req = client.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith('http') ? res.headers.location : `${targetUrl.origin}${res.headers.location}`;
        res.resume();
        return fetchUrl(next, { timeoutMs, redirects: redirects - 1 }).then(resolve, reject);
      }
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve(raw));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('fetch_timeout')); });
    req.end();
  });
}

function parseRssItems(xml, limit = 5) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRe.exec(xml)) !== null && items.length < limit) {
    const block = match[1];
    const title = extractTag(block, 'title');
    const link = extractTag(block, 'link') || extractAttr(block, 'link', 'href');
    const description = extractTag(block, 'description') || extractTag(block, 'summary');
    if (title) items.push({ title: stripCdata(title), link: stripCdata(link), description: stripCdata(description)?.slice(0, 300) });
  }
  return items;
}

function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = re.exec(xml);
  return m ? m[1].trim() : '';
}

function extractAttr(xml, tag, attr) {
  const re = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, 'i');
  const m = re.exec(xml);
  return m ? m[1].trim() : '';
}

function stripCdata(str) {
  if (!str) return str;
  return str.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim();
}

export async function fetchSmolAiNews({ limit = 5 } = {}) {
  try {
    const xml = await fetchUrl('https://news.smol.ai/rss.xml');
    const items = parseRssItems(xml, limit);
    return { source: 'smol.ai', items, ok: true };
  } catch (err) {
    return { source: 'smol.ai', items: [], ok: false, error: err.message };
  }
}

export async function fetchHuggingFacePapers({ limit = 5 } = {}) {
  try {
    const raw = await fetchUrl(`https://huggingface.co/api/daily_papers?limit=${limit}`);
    const data = JSON.parse(raw);
    const papers = Array.isArray(data) ? data : (data.papers ?? []);
    const items = papers.slice(0, limit).map((p) => ({
      title: p.paper?.title ?? p.title ?? 'Unknown',
      link: `https://huggingface.co/papers/${p.paper?.id ?? p.id ?? ''}`,
      authors: (p.paper?.authors ?? []).slice(0, 3).map((a) => a.name ?? a).join(', '),
      upvotes: p.totalScore ?? p.upvotes ?? 0
    }));
    return { source: 'huggingface', items, ok: true };
  } catch (err) {
    return { source: 'huggingface', items: [], ok: false, error: err.message };
  }
}

export async function fetchArxivPapers({ query = 'cat:cs.AI', limit = 3 } = {}) {
  try {
    const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&start=0&max_results=${limit}&sortBy=submittedDate&sortOrder=descending`;
    const xml = await fetchUrl(url);
    const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
    const items = [];
    let match;
    while ((match = entryRe.exec(xml)) !== null && items.length < limit) {
      const block = match[1];
      const title = extractTag(block, 'title').replace(/\s+/g, ' ');
      const id = extractTag(block, 'id').replace('http://arxiv.org/abs/', 'https://arxiv.org/abs/');
      const summary = extractTag(block, 'summary').replace(/\s+/g, ' ').slice(0, 200);
      if (title) items.push({ title, link: id, summary });
    }
    return { source: 'arxiv', items, ok: true };
  } catch (err) {
    return { source: 'arxiv', items: [], ok: false, error: err.message };
  }
}

export async function fetchTheBatch({ limit = 3 } = {}) {
  // TechCrunch AI section RSS as a reliable alternative
  try {
    const xml = await fetchUrl('https://techcrunch.com/category/artificial-intelligence/feed/');
    const items = parseRssItems(xml, limit);
    return { source: 'TechCrunch AI', items, ok: true };
  } catch (err) {
    return { source: 'TechCrunch AI', items: [], ok: false, error: err.message };
  }
}

export async function fetchSimonWillison({ limit = 3 } = {}) {
  try {
    const xml = await fetchUrl('https://simonwillison.net/atom/everything/');
    const items = [];
    const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
    let match;
    while ((match = entryRe.exec(xml)) !== null && items.length < limit) {
      const block = match[1];
      const title = stripCdata(extractTag(block, 'title'));
      const link = extractAttr(block, 'link', 'href') || stripCdata(extractTag(block, 'link'));
      const summary = stripCdata(extractTag(block, 'summary') || extractTag(block, 'content'))?.slice(0, 300);
      if (title) items.push({ title, link, description: summary });
    }
    return { source: 'Simon Willison', items, ok: true };
  } catch (err) {
    return { source: 'Simon Willison', items: [], ok: false, error: err.message };
  }
}

export async function fetchLatentSpace({ limit = 3 } = {}) {
  try {
    const xml = await fetchUrl('https://www.latent.space/feed');
    const items = parseRssItems(xml, limit);
    return { source: 'Latent Space', items, ok: true };
  } catch (err) {
    return { source: 'Latent Space', items: [], ok: false, error: err.message };
  }
}

export async function fetchAllNews({ smolLimit = 3, hfLimit = 3, arxivLimit = 2, batchLimit = 2, simonLimit = 2, latentLimit = 2 } = {}) {
  const [smol, hf, arxiv, batch, simon, latent] = await Promise.allSettled([
    fetchSmolAiNews({ limit: smolLimit }),
    fetchHuggingFacePapers({ limit: hfLimit }),
    fetchArxivPapers({ limit: arxivLimit }),
    fetchTheBatch({ limit: batchLimit }),
    fetchSimonWillison({ limit: simonLimit }),
    fetchLatentSpace({ limit: latentLimit })
  ]);
  return {
    smol: smol.status === 'fulfilled' ? smol.value : { source: 'smol.ai', items: [], ok: false },
    huggingface: hf.status === 'fulfilled' ? hf.value : { source: 'huggingface', items: [], ok: false },
    arxiv: arxiv.status === 'fulfilled' ? arxiv.value : { source: 'arxiv', items: [], ok: false },
    batch: batch.status === 'fulfilled' ? batch.value : { source: 'The Batch', items: [], ok: false },
    simon: simon.status === 'fulfilled' ? simon.value : { source: 'Simon Willison', items: [], ok: false },
    latent: latent.status === 'fulfilled' ? latent.value : { source: 'Latent Space', items: [], ok: false }
  };
}
