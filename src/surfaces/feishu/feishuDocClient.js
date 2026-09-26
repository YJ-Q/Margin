// High-level document operations for the job assistant feature.
// Wraps feishuClient docx/drive methods and handles markdown→block conversion.

export function createFeishuDocClient({ feishuClient }) {

  // ── Folder helpers ──────────────────────────────────────────────────────────

  async function ensureFolder({ parentToken, name }) {
    const res = await feishuClient.createFolder({ parentToken, name });
    const token = res?.data?.token;
    if (!token) throw new Error(`create_folder_failed: ${JSON.stringify(res)}`);
    return token;
  }

  // ── Document creation ───────────────────────────────────────────────────────

  async function createDoc({ folderToken, title }) {
    const res = await feishuClient.createDoc({ folderToken, title });
    const doc = res?.data?.document;
    if (!doc?.document_id) throw new Error(`create_doc_failed: ${JSON.stringify(res)}`);
    return {
      documentId: doc.document_id,
      url: `https://www.feishu.cn/docx/${doc.document_id}`
    };
  }

  // ── Content writing ─────────────────────────────────────────────────────────

  async function appendMarkdown({ documentId, markdown }) {
    const blocks = markdownToBlocks(markdown);
    if (blocks.length === 0) return;
    const res = await feishuClient.appendDocBlocks({ documentId, blocks });
    if (res?.code !== 0) throw new Error(`append_blocks_failed: ${JSON.stringify(res)}`);
  }

  // ── Search ──────────────────────────────────────────────────────────────────

  async function searchDocs({ query }) {
    const res = await feishuClient.searchDocs({ query });
    const items = res?.data?.docs_entities ?? [];
    return items.map(d => ({
      title: d.title,
      documentId: d.token,
      url: d.url,
      type: d.docs_type
    }));
  }

  return { ensureFolder, createDoc, appendMarkdown, searchDocs };
}

// ── Markdown → Feishu Block conversion ──────────────────────────────────────
// Supports: # h1, ## h2, ### h3, --- divider, **bold**, plain paragraph, - list

export function markdownToBlocks(markdown) {
  const lines = markdown.split('\n');
  const blocks = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^---+$/.test(line.trim())) {
      blocks.push({ block_type: 22 }); // divider
      continue;
    }

    const h3 = line.match(/^### (.+)/);
    if (h3) { blocks.push(headingBlock(3, h3[1])); continue; }

    const h2 = line.match(/^## (.+)/);
    if (h2) { blocks.push(headingBlock(2, h2[1])); continue; }

    const h1 = line.match(/^# (.+)/);
    if (h1) { blocks.push(headingBlock(1, h1[1])); continue; }

    const li = line.match(/^[-*] (.+)/);
    if (li) { blocks.push(bulletBlock(li[1])); continue; }

    // blank line → skip (feishu renders natural spacing between blocks)
    if (line.trim() === '') continue;

    blocks.push(paragraphBlock(line));
  }

  return blocks;
}

function headingBlock(level, text) {
  // block_type: 3=h1, 4=h2, 5=h3
  return {
    block_type: level + 2,
    [`heading${level}`]: { elements: inlineElements(text), style: {} }
  };
}

function paragraphBlock(text) {
  return {
    block_type: 2,
    paragraph: { elements: inlineElements(text), style: {} }
  };
}

function bulletBlock(text) {
  return {
    block_type: 12,
    bullet: { elements: inlineElements(text), style: {} }
  };
}

function inlineElements(text) {
  const elements = [];
  // Parse **bold** segments
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      elements.push(textRun(text.slice(last, m.index), false));
    }
    elements.push(textRun(m[1], true));
    last = m.index + m[0].length;
  }
  if (last < text.length) elements.push(textRun(text.slice(last), false));
  return elements.length > 0 ? elements : [textRun(text, false)];
}

function textRun(content, bold) {
  return {
    type: 'text_run',
    text_run: {
      content,
      text_element_style: { bold, italic: false, strikethrough: false, underline: false }
    }
  };
}
