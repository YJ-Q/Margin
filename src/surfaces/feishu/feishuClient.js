import crypto from 'node:crypto';
import https from 'node:https';

export function createFeishuClient({ appId, appSecret }) {
  if (!appId || !appSecret) throw new TypeError('feishu_client_missing_credentials');

  let tokenCache = null;

  async function getAccessToken() {
    if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
      return tokenCache.token;
    }
    const body = JSON.stringify({ app_id: appId, app_secret: appSecret });
    const data = await request('POST', 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', body);
    if (!data.tenant_access_token) throw new Error('feishu_token_failed');
    tokenCache = { token: data.tenant_access_token, expiresAt: Date.now() + data.expire * 1000 };
    return tokenCache.token;
  }

  async function sendMessage({ receiveId, receiveIdType = 'open_id', msgType = 'text', content }) {
    const token = await getAccessToken();
    const body = JSON.stringify({
      receive_id: receiveId,
      msg_type: msgType,
      content: typeof content === 'string' ? content : JSON.stringify(content)
    });
    return request('POST', `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, body, token);
  }

  async function replyMessage({ messageId, msgType = 'text', content }) {
    const token = await getAccessToken();
    const body = JSON.stringify({
      msg_type: msgType,
      content: typeof content === 'string' ? content : JSON.stringify(content)
    });
    return request('POST', `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, body, token);
  }

  async function patchMessage({ messageId, content, msgType = 'interactive' }) {
    const token = await getAccessToken();
    const body = JSON.stringify({
      msg_type: msgType,
      content: typeof content === 'string' ? content : JSON.stringify(content)
    });
    return request('PATCH', `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`, body, token);
  }

  async function pinMessage({ messageId }) {
    const token = await getAccessToken();
    const body = JSON.stringify({ message_id: messageId });
    return request('POST', `https://open.feishu.cn/open-apis/im/v1/pins`, body, token);
  }

  // ── Drive API ────────────────────────────────────────────────────────────────

  async function createFolder({ parentToken, name }) {
    const token = await getAccessToken();
    const body = JSON.stringify({ name, folder_token: parentToken });
    return request('POST', 'https://open.feishu.cn/open-apis/drive/v1/files/create_folder', body, token);
  }

  async function listFolderFiles({ folderToken, pageSize = 50 }) {
    const token = await getAccessToken();
    const url = `https://open.feishu.cn/open-apis/drive/v1/files?folder_token=${encodeURIComponent(folderToken)}&page_size=${pageSize}`;
    return requestGet(url, token);
  }

  async function searchDocs({ query, count = 20 }) {
    const token = await getAccessToken();
    const body = JSON.stringify({ search_key: query, count, offset: 0, docs_types: ['doc', 'docx'] });
    return request('POST', 'https://open.feishu.cn/open-apis/suite/docs-api/search/object', body, token);
  }

  async function moveFile({ fileToken, fileType, folderToken }) {
    const token = await getAccessToken();
    const body = JSON.stringify({ type: fileType, folder_token: folderToken });
    return request('POST', `https://open.feishu.cn/open-apis/drive/v1/files/${fileToken}/move`, body, token);
  }

  // ── Docx API ─────────────────────────────────────────────────────────────────

  async function createDoc({ folderToken, title }) {
    const token = await getAccessToken();
    const body = JSON.stringify({ folder_token: folderToken, title });
    return request('POST', 'https://open.feishu.cn/open-apis/docx/v1/documents', body, token);
  }

  async function getDocBlocks({ documentId }) {
    const token = await getAccessToken();
    return requestGet(`https://open.feishu.cn/open-apis/docx/v1/documents/${documentId}/blocks`, token);
  }

  async function appendDocBlocks({ documentId, blocks }) {
    const token = await getAccessToken();
    const body = JSON.stringify({ children: blocks, index: -1 });
    return request('POST', `https://open.feishu.cn/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`, body, token);
  }

  // ── Bitable API ──────────────────────────────────────────────────────────────

  async function listBitableRecords({ appToken, tableId, pageSize = 100, pageToken, filter }) {
    const token = await getAccessToken();
    const params = new URLSearchParams({ page_size: pageSize });
    if (pageToken) params.set('page_token', pageToken);
    if (filter) params.set('filter', filter);
    return requestGet(`https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records?${params}`, token);
  }

  async function createBitableRecord({ appToken, tableId, fields }) {
    const token = await getAccessToken();
    const body = JSON.stringify({ fields });
    return request('POST', `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`, body, token);
  }

  async function updateBitableRecord({ appToken, tableId, recordId, fields }) {
    const token = await getAccessToken();
    const body = JSON.stringify({ fields });
    return request('PUT', `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`, body, token);
  }

  async function listBitableTables({ appToken }) {
    const token = await getAccessToken();
    return requestGet(`https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables`, token);
  }

  return Object.freeze({
    getAccessToken,
    sendMessage, replyMessage, patchMessage, pinMessage,
    createFolder, listFolderFiles, searchDocs, moveFile,
    createDoc, getDocBlocks, appendDocBlocks,
    listBitableRecords, createBitableRecord, updateBitableRecord, listBitableTables
  });
}

export function verifyFeishuSignature({ timestamp, nonce, body, secret }) {
  const str = timestamp + nonce + secret + body;
  return crypto.createHash('sha256').update(str).digest('hex');
}

function request(method, url, body, token) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function requestGet(url, token) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}
