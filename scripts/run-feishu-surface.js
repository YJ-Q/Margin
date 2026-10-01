import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import dotenv from 'dotenv';
import { createFeishuClient } from '../src/surfaces/feishu/feishuClient.js';
import { createFeishuWebhookHandler } from '../src/surfaces/feishu/feishuWebhookHandler.js';
import { buildMorningBrief } from '../src/surfaces/feishu/morningBrief.js';
import { createFeishuHttpAdapter } from '../src/surfaces/feishu/httpAdapter.js';
import { createCommandHandler } from '../src/surfaces/feishu/commandHandler.js';
import { createFeishuDocClient } from '../src/surfaces/feishu/feishuDocClient.js';
import { createJobStore } from '../src/surfaces/feishu/jobStore.js';
import { createInterviewHandler } from '../src/surfaces/feishu/interviewHandler.js';
import { createJobTools } from '../src/surfaces/feishu/jobTools.js';
import { createResumeBitableTools } from '../src/surfaces/feishu/resumeBitableTools.js';
import { createClaudeAgentLoop } from '../src/runtime/claude/claudeAgentLoop.js';
import { createMarginCore } from '../src/core/createMarginCore.js';
import { createPiTerminalPilotRuntime } from '../src/runtime/pi/piTerminalPilotRuntime.js';
import { createTerminalPilotController } from '../src/pilot/terminalPilotController.js';

import { createMonitor } from '../src/surfaces/feishu/monitor.js';

dotenv.config();

const PORT = Number(process.env.FEISHU_PORT ?? 3200);
const FEISHU_APP_ID = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;
const FEISHU_ENCRYPT_KEY = process.env.FEISHU_ENCRYPT_KEY ?? '';
const FEISHU_OWNER_OPEN_ID = process.env.FEISHU_OWNER_OPEN_ID ?? '';

const FEISHU_MONITOR_CHAT_ID = process.env.FEISHU_MONITOR_CHAT_ID ?? '';

if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
  console.error('FEISHU_APP_ID and FEISHU_APP_SECRET must be set in .env');
  process.exit(1);
}

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = path.resolve(ROOT_DIR, process.env.MARGIN_CORE_DB_PATH ?? path.join('data', 'terminal-pilot', 'margin-core.sqlite'));
const JOB_DB_PATH = path.resolve(ROOT_DIR, process.env.FEISHU_JOB_DB_PATH ?? path.join('data', 'job-tracker', 'job_tracker.sqlite'));
const AGENT_DIR = path.resolve(ROOT_DIR, 'data', 'feishu-agent');
const clock = () => new Date().toISOString();
const idFactory = (prefix) => `${prefix}-${randomUUID()}`;

const feishuClient = createFeishuClient({ appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET });
const feishuDocClient = createFeishuDocClient({ feishuClient });

// jobStore and interviewHandler are initialized async after server starts
let jobStore = null;
let interviewHandler = null;

async function initJobServices() {
  try {
    jobStore = await createJobStore({ dbPath: JOB_DB_PATH });
    interviewHandler = createInterviewHandler({
      feishuDocClient,
      jobStore,
      apiKey: process.env.SILICONFLOW_API_KEY
    });
    console.log('[feishu] job services initialized');
  } catch (err) {
    console.error('[feishu] job services init failed:', err.message);
  }
}

// ── Claude Agent ─────────────────────────────────────────────────────────────
let claudeAgent = null;

async function ensureClaudeAgent(core) {
  if (claudeAgent) return claudeAgent;
  const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.YAPI_API_KEY;
  if (!apiKey) {
    console.warn('[feishu] ANTHROPIC_API_KEY / YAPI_API_KEY not set — Claude agent disabled');
    return null;
  }
  const jobTools = createJobTools({ interviewHandler, jobStore });
  const resumeTools = createResumeBitableTools({ feishuClient, dataDir: path.resolve(ROOT_DIR, 'data') });
  const extraTools = [...jobTools, ...resumeTools];

  claudeAgent = await createClaudeAgentLoop({
    apiKey,
    model: process.env.ANTHROPIC_MODEL,
    systemPrompt: [
      '你是 Margin，用户的私人 AI 助手，运行在本地电脑上。',
      '你通过飞书与用户沟通。回复使用中文，简洁直接。',
      '你可以使用工具管理用户的记忆、项目状态、任务，以及读写用户的简历资料库。',
      '简历相关工具：resume_list_entries（查看条目）、resume_add_entry（新增条目）、resume_generate_yaml（生成简历文件）。',
      '用户希望你帮助他求职：筛选岗位、生成打招呼语句、从简历资料库生成针对特定岗位的简历内容。'
    ].join('\n'),
    v1Tools: core?.v1Tools ? {
      memory_search: core.v1Tools.memory_search,
      memory_propose: core.v1Tools.memory_propose,
      state_update: core.v1Tools.state_update,
      action_update: core.v1Tools.action_update
    } : undefined,
    extraTools,
    dbPath: path.resolve(ROOT_DIR, 'data', 'claude-agent', 'history.sqlite'),
    sessionId: 'feishu'
  });
  console.log('[feishu] Claude agent initialized');
  return claudeAgent;
}

// ── Pi session controller (legacy fallback) ──────────────────────────────────
let pilot = null;
let pilotStarted = false;

function providerConfig() {
  const provider = process.env.MARGIN_PI_PROVIDER ?? 'yapi';
  const modelId = process.env.MARGIN_PI_MODEL ?? 'gpt-5.6-terra';
  const baseUrl = process.env.MARGIN_PI_BASE_URL ?? (provider === 'yapi' ? 'https://yapi.click/v1' : undefined);
  const api = process.env.MARGIN_PI_API ?? (provider === 'yapi' ? 'openai-responses' : undefined);
  const keyName = process.env.MARGIN_PI_API_KEY_ENV ?? (provider === 'yapi' ? 'YAPI_API_KEY' : undefined);
  const apiKey = keyName ? process.env[keyName] : undefined;
  if (![provider, modelId, baseUrl, api, apiKey].every(v => typeof v === 'string' && v.trim())) return null;
  return { provider, modelId, customProvider: { baseUrl, api, apiKey } };
}

// Registry that persists the active feishu workstream ID across restarts
const REGISTRY_KEY = 'feishu_workstream_id';
const REGISTRY_PATH = path.resolve(ROOT_DIR, 'data', 'feishu-agent', 'registry.json');
const registry = {
  load: async () => {
    try {
      const raw = await readFile(REGISTRY_PATH, 'utf8');
      return JSON.parse(raw)[REGISTRY_KEY] ?? null;
    } catch { return null; }
  },
  save: async (id) => {
    let data = {};
    try { data = JSON.parse(await readFile(REGISTRY_PATH, 'utf8')); } catch {}
    data[REGISTRY_KEY] = id;
    await writeFile(REGISTRY_PATH, JSON.stringify(data, null, 2));
  }
};

const serviceStartedAt = Date.now();
let lastActivityAt = null;
let messageCount = 0;

async function getPilotState() {
  const state = {
    pilotReady: pilot && pilotStarted,
    startedAt: serviceStartedAt,
    lastActivityAt,
    messageCount
  };
  if (!pilot || !pilotStarted) return state;
  try {
    const statusResult = await pilot.handle('/status');
    if (statusResult?.runStatus) state.runStatus = statusResult.runStatus;
    else if (statusResult?.text) {
      const m = statusResult.text.match(/Run (\w+):/);
      if (m) state.runStatus = m[1];
    }
  } catch {}
  try {
    const stateResult = await pilot.handle('/state');
    if (stateResult?.text) {
      // Extract current task from state text
      const taskMatch = stateResult.text.match(/当前任务[：:]\s*(.+?)[\n\r]/);
      if (taskMatch) state.currentTask = taskMatch[1].trim();
    }
  } catch {}
  return state;
}

async function ensurePilot() {
  if (pilot && pilotStarted) return pilot;
  if (pilot) {
    try { await pilot.start(); pilotStarted = true; } catch {}
    return pilot;
  }

  await mkdir(path.dirname(DB_PATH), { recursive: true });
  await mkdir(AGENT_DIR, { recursive: true });

  const core = await createMarginCore({ enabled: true, dbPath: DB_PATH, clock, idFactory });
  const piConfig = providerConfig();
  if (!piConfig) {
    console.warn('[feishu] Pi provider not configured — chat will return error');
    return null;
  }

  const extraTools = createJobTools({ interviewHandler, jobStore });
  console.log('[feishu] registering extra tools:', extraTools.map(t => t.name));
  const runtime = await createPiTerminalPilotRuntime({
    repositoryRoot: ROOT_DIR, agentDir: AGENT_DIR,
    ...piConfig, tools: core.v1Tools,
    extraTools
  });

  pilot = createTerminalPilotController({
    core, runtime, registry, clock, idFactory
  });

  try {
    const startResult = await pilot.start();
    console.log('[feishu] Pi pilot started, run status:', startResult.runStatus);
    if (startResult.runStatus === 'paused') {
      await pilot.handle('/resume');
      const newSession = await pilot.handle('/new');
      console.log('[feishu] new session started:', newSession.text?.slice(0, 80));
    }
    pilotStarted = true;
  } catch (err) {
    console.error('[feishu] pilot start failed:', err.message);
    pilotStarted = false;
    monitor.notify({ type: 'error', text: `Pi 启动失败：${err.message}` }).catch(() => {});
  }
  return pilot;
}

// ── Feishu message handling ──────────────────────────────────────────────────

const commandHandler = createCommandHandler({
  feishuClient,
  ownerOpenId: FEISHU_OWNER_OPEN_ID,
  ensurePilot,
  getPilotStarted: () => pilotStarted,
  getPilot: () => pilot,
  getInterviewHandler: () => interviewHandler,
  getAgent: () => claudeAgent
});

async function onMessage(ctx, client) {
  const rawText = typeof ctx.content === 'string' ? ctx.content : '';
  // Strip @mention tags (group chats)
  const text = rawText.replace(/<at[^>]*>[^<]*<\/at>/g, '').replace(/@\S+\s*/g, '').trim();
  console.log(`[feishu] message from ${ctx.senderId}: "${text.slice(0, 100)}"`);

  if (!text) return;

  // Acknowledge non-command messages immediately
  if (!commandHandler.isInstantReply(text) && ctx.messageId) {
    const ackResult = await client.replyMessage({
      messageId: ctx.messageId,
      content: JSON.stringify({ text: '⏳ 收到，处理中...' })
    }).catch(err => ({ error: err.message }));
    console.log(`[feishu] ack reply result:`, JSON.stringify(ackResult));
  }

  try {
    lastActivityAt = new Date().toISOString();
    messageCount++;
    const reply = await commandHandler.handle(text, ctx);
    if (!reply) return;

    if (typeof reply === 'object' && reply.header) {
      const target = ctx.senderId || FEISHU_OWNER_OPEN_ID;
      if (target) await client.sendMessage({ receiveId: target, receiveIdType: 'open_id', msgType: 'interactive', content: reply });
    } else if (typeof reply === 'string' && ctx.messageId) {
      await client.replyMessage({ messageId: ctx.messageId, content: JSON.stringify({ text: reply }) });
    }
  } catch (err) {
    console.error('[feishu] handleUserMessage error:', err?.message);
    monitor.notify({ type: 'error', text: `消息处理出错：${err?.message ?? 'unknown_error'}` }).catch(() => {});
    if (ctx.messageId) {
      await client.replyMessage({
        messageId: ctx.messageId,
        content: JSON.stringify({ text: `处理出错：${err?.message ?? 'unknown_error'}` })
      }).catch(() => {});
    }
  }
}

// ── HTTP Server ──────────────────────────────────────────────────────────────

const monitor = createMonitor({
  feishuClient,
  chatId: FEISHU_MONITOR_CHAT_ID,
  getPilotState
});

const handler = createFeishuWebhookHandler({ feishuClient, onMessage, encryptKey: FEISHU_ENCRYPT_KEY });

const server = http.createServer(createFeishuHttpAdapter({
  webhookHandler: handler, feishuClient, ownerOpenId: FEISHU_OWNER_OPEN_ID,
  getPilotReady: () => pilotStarted, buildBrief: buildMorningBrief,
}));

// Init job services before starting server so interviewHandler is ready
await initJobServices();

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`margin_feishu_ready http://127.0.0.1:${server.address().port}`);
  const core = await createMarginCore({ enabled: true, dbPath: DB_PATH, clock, idFactory }).catch(() => null);
  ensureClaudeAgent(core)
    .then(() => ensurePilot())
    .then(() => monitor.start())
    .catch(err => console.error('[feishu] background init error:', err.message));
});

server.on('error', err => { console.error('feishu server error', err.message); process.exit(1); });
