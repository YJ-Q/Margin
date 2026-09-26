// Worker: runs ONE tested recovery session in a fresh, isolated in-memory DeepSeek context.
// Usage: node worker.mjs <runConfig.json> <recordFile>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPi } from './lib/pi-loader.mjs';
import { createSandboxTools } from './lib/sandbox-tools.mjs';

function readUtf8NoBom(p) {
  const buf = fs.readFileSync(p);
  let s = buf.toString('utf8');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s;
}

const configFile = process.argv[2];
const recordFile = process.argv[3];
if (!configFile || !recordFile) {
  console.error('usage: worker.mjs <runConfig.json> <recordFile>');
  process.exit(2);
}

const cfg = JSON.parse(readUtf8NoBom(configFile));
const { runId, caseId, arm, sandboxRoot, promptFile, providerId, modelId, thinking } = cfg;
const sandboxNorm = path.resolve(sandboxRoot);

async function main() {
  const pi = await loadPi();
  const { ModelRuntime, DefaultResourceLoader, SettingsManager, SessionManager, createAgentSession, getAgentDir } = pi;

  const record = {
    runId,
    caseId,
    arm,
    model: `${providerId}/${modelId}`,
    reasoningLevel: thinking,
    provider: providerId,
    infraStatus: 'ok',
    startTs: null,
    endTs: null,
    durationMs: null,
    modelPromptStartMs: null,
    modelPromptEndMs: null,
    sessionId: null,
    rawResponse: null,
    parsedRecovery: null,
    hasAllRequiredKeys: false,
    parseError: null,
    toolCalls: [],
    deniedToolCalls: [],
    outOfSandboxAttempts: [],
    errors: [],
    note: null
  };

  const started = Date.now();
  record.startTs = new Date(started).toISOString();

  const audit = {
    log(name, args) {
      if (record.toolCalls.length < 400) {
        record.toolCalls.push({
          tool: name,
          args: JSON.stringify(args).slice(0, 2000),
          tsMs: Date.now()
        });
      }
    },
    deny(command, reasons) {
      record.deniedToolCalls.push({ command: String(command).slice(0, 2000), reasons, tsMs: Date.now() });
    }
  };

  const promptText = readUtf8NoBom(promptFile);

  // 1. Model runtime (global pi config: ~/.pi/agent/auth.json + models-store)
  const modelRuntime = await ModelRuntime.create();
  const model = modelRuntime.getModel(providerId, modelId);
  if (!model) throw new Error(`model not available: ${providerId}/${modelId}`);

  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false }
  });

  const loader = new DefaultResourceLoader({
    cwd: sandboxNorm,
    agentDir: getAgentDir(),
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true
  });
  await loader.reload();

  const toolDefs = createSandboxTools({ sandboxRoot: sandboxNorm, audit, defineTool: pi.defineTool });
  const toolNames = toolDefs.map((t) => t.name);

  const { session } = await createAgentSession({
    cwd: sandboxNorm,
    agentDir: getAgentDir(),
    model,
    thinkingLevel: thinking,
    modelRuntime,
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager: SessionManager.inMemory(sandboxNorm),
    customTools: toolDefs,
    tools: toolNames
  });

  record.sessionId = session.sessionId;

  // subscribe for diagnostics
  let thinkingSeen = 0;
  const unsub = session.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'thinking_delta') thinkingSeen += 1;
  });

  const promptStart = Date.now();
  record.modelPromptStartMs = promptStart - started;
  await session.prompt(promptText, { source: 'user' });
  const promptEnd = Date.now();
  record.modelPromptEndMs = promptEnd - started;
  unsub();

  // final assistant message text
  const messages = session.agent?.state?.messages ?? [];
  const assistantMessages = messages.filter((msg) => msg && msg.role === 'assistant');
  const finalMsg = assistantMessages[assistantMessages.length - 1];
  let finalText = '';
  if (finalMsg && Array.isArray(finalMsg.content)) {
    for (const part of finalMsg.content) {
      if (part && part.type === 'text') finalText += part.text;
    }
  }
  record.rawResponse = finalText;
  record.hasThinkingOutput = thinkingSeen > 0;

  // parse structured JSON
  const parsed = tryParseJson(finalText);
  if (parsed && parsed.obj) {
    record.parsedRecovery = parsed.obj;
    const required = ['goal', 'progress', 'pending', 'historicalValidation', 'recommendedFollowUp', 'currentApplicability', 'unsafeAssumptions'];
    const missing = required.filter((k) => !(k in parsed.obj));
    record.hasAllRequiredKeys = missing.length === 0;
    if (missing.length) record.note = `missing required keys: ${missing.join(', ')}`;
  } else {
    record.parseError = parsed ? parsed.error : 'no final assistant text';
  }

  session.dispose();

  const ended = Date.now();
  record.endTs = new Date(ended).toISOString();
  record.durationMs = ended - started;
  record.workerDurationMs = record.durationMs;

  fs.writeFileSync(recordFile, JSON.stringify(record, null, 2), 'utf8');
  console.log(`RUN_COMPLETE ${runId} status=ok durationMs=${record.durationMs}`);
  process.exit(0);
}

function tryParseJson(text) {
  if (!text || !text.trim()) return null;
  let t = text.trim();
  // strip code fences
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const attempt = (s) => {
    try {
      return { obj: JSON.parse(s) };
    } catch {
      return null;
    }
  };
  const direct = attempt(t);
  if (direct) return direct;
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const inner = attempt(t.slice(first, last + 1));
    if (inner) return inner;
  }
  return { error: 'no parseable JSON object in final text' };
}

main().catch(async (err) => {
  const failed = {
    runId: cfg.runId,
    caseId: cfg.caseId,
    arm: cfg.arm,
    model: `${cfg.providerId}/${cfg.modelId}`,
    reasoningLevel: cfg.thinking,
    provider: cfg.providerId,
    infraStatus: 'error',
    startTs: new Date(Date.now()).toISOString(),
    endTs: null,
    durationMs: null,
    error: String((err && err.stack) || err),
    rawResponse: null
  };
  try {
    fs.writeFileSync(recordFile, JSON.stringify(failed, null, 2), 'utf8');
  } catch { /* ignore */ }
  console.error(`RUN_ERROR ${cfg.runId}: ${err && err.message ? err.message : err}`);
  process.exit(17);
});
