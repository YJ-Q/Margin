import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { adapters, extractContext } from 'continues';

const root = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(root, 'output');
fs.mkdirSync(output, { recursive: true });
const codexRoot = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const workspace = path.resolve(root, '../..');
const sessions = await adapters.codex.parseSessions();
const candidates = sessions;
fs.writeFileSync(path.join(output, 'discovery.json'), JSON.stringify({
  capturedAt: new Date().toISOString(), codexRoot, total: sessions.length,
  nativeArchivedDirectoryExists: fs.existsSync(path.join(codexRoot, 'archived_sessions')),
  candidates,
}, null, 2));
console.log(JSON.stringify({ total: sessions.length, candidates: candidates.map(s => ({
  id: s.id, cwd: s.cwd, bytes: s.bytes, updatedAt: s.updatedAt, summary: s.summary,
})) }, null, 2));
if (process.argv.includes('--discover')) {
  for (const s of sessions) {
    const events = fs.readFileSync(s.originalPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const conversation = events.filter(e => e.type === 'response_item' && e.payload?.type === 'message');
    const user = conversation.filter(e => e.payload.role === 'user');
    const calls = events.filter(e => /^(function_call|custom_tool_call)$/.test(e.payload?.type));
    const names = {};
    for (const e of calls) names[e.payload.name] = (names[e.payload.name] || 0) + 1;
    console.log(JSON.stringify({ id: s.id, records: events.length, conversation: conversation.length,
      toolCalls: names, users: user.slice(-3).map(e => e.payload.content?.filter(c => c.text).map(c => c.text).join('\n').slice(0, 500)),
      lastAssistant: conversation.filter(e => e.payload.role === 'assistant').at(-1)?.payload.content?.filter(c => c.text).map(c => c.text).join('\n').slice(0, 800),
    }, null, 2));
  }
  process.exit(0);
}

const sha256 = data => createHash('sha256').update(data).digest('hex');
const writeJson = (name, data) => fs.writeFileSync(path.join(output, name), JSON.stringify(data, null, 2));
const selectedId = process.argv.find(a => a.startsWith('--session='))?.slice(10)
  || '01a070e6-3bd9-7591-aa4e-31b364badda1';
const selected = sessions.find(s => s.id === selectedId);
if (!selected) throw new Error(`Session not discovered: ${selectedId}`);

// Freeze exactly one complete-line prefix; live sessions can append while we run.
// On rerun reuse this checkpoint unless explicitly asked to refresh it.
const snapshotPath = path.join(output, path.basename(selected.originalPath));
const capturePath = path.join(output, 'capture.json');
let capture;
if (fs.existsSync(snapshotPath) && !process.argv.includes('--refresh')) {
  capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
} else {
  const bytes = fs.readFileSync(selected.originalPath);
  const boundary = bytes.lastIndexOf(10) + 1;
  if (!boundary) throw new Error('No complete JSONL record found');
  const prefix = bytes.subarray(0, boundary);
  fs.writeFileSync(snapshotPath, prefix);
  capture = { capturedAt: new Date().toISOString(), originalPath: selected.originalPath,
    snapshotPath, bytes: prefix.length, sha256: sha256(prefix),
    omittedTrailingBytes: bytes.length - prefix.length, discoveredSession: selected };
  writeJson('capture.json', capture);
}
const raw = fs.readFileSync(snapshotPath);
if (sha256(raw) !== capture.sha256) throw new Error('Checkpoint hash mismatch');
const physicalLines = raw.toString('utf8').split('\n');
const records = [];
const invalidLines = [];
for (const [i, line] of physicalLines.entries()) {
  if (!line.trim()) continue;
  try { records.push({ line: i + 1, event: JSON.parse(line) }); }
  catch { invalidLines.push({ line: i + 1, chars: line.length, sha256: sha256(line) }); }
}
if (invalidLines.length) throw new Error(`Malformed checkpoint records: ${JSON.stringify(invalidLines)}`);

// Baseline metadata is the public discovery result at capture time, including any inaccuracies.
const session = { ...capture.discoveredSession,
  createdAt: new Date(capture.discoveredSession.createdAt),
  updatedAt: new Date(capture.discoveredSession.updatedAt), originalPath: snapshotPath };
const standard = await extractContext(session);

// getPreset / VerbosityConfig are not exported from the package root in 4.1.1.
// Supply the complete structural config through the public extractContext signature.
// This lifts configurable caps; hardcoded parser/collector losses are measured below.
const n = records.length + 1;
const chars = raw.length + 1;
const config = {
  preset: 'full', recentMessages: n, maxMessageChars: chars,
  shell: { maxSamples: n, stdoutLines: n, stderrLines: n, maxChars: chars, showCommand: true, showExitCode: true },
  read: { maxSamples: n, maxChars: chars, showLineRange: true },
  write: { maxSamples: n, diffLines: n, maxChars: chars },
  edit: { maxSamples: n, diffLines: n, maxChars: chars },
  grep: { maxSamples: n, maxChars: chars, showPattern: true, matchLines: n },
  mcp: { maxSamplesPerNamespace: n, paramChars: chars, resultChars: chars,
    thinkingTools: { extractReasoning: true, maxReasoningChars: chars } },
  task: { maxSamples: n, includeSubagentResults: true, subagentResultChars: chars, recurseSubagents: false },
  thinking: { include: true, maxChars: chars, maxHighlights: n },
  compactSummary: { maxChars: chars },
  pendingTasks: { extractFromThinking: true, extractFromSubagents: true, maxTasks: n },
  handoff: { finalAnswerChars: chars, timelineWindow: n, includeToolAppendix: true, pathPolicy: 'raw' },
  agents: { claude: { filterProgressEvents: false, parseSubagents: false, parseToolResultsDir: false,
    separateHumanFromToolResults: true, chainCompactedHistory: true, chainMaxDepth: 0, chainSummaryChars: chars } },
};
const expanded = await extractContext(session, config);
fs.writeFileSync(path.join(output, 'baseline-continues-handoff.md'), standard.markdown);
writeJson('continues-standard-context.json', standard);

const tally = values => values.reduce((a, v) => (a[v] = (a[v] || 0) + 1, a), {});
const pointers = predicate => records.filter(r => predicate(r.event)).map(r => r.line);
const isCall = e => e.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(e.payload?.type);
const isResult = e => e.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(e.payload?.type);
const isReasoning = e => e.payload?.type === 'reasoning' || e.payload?.type === 'agent_reasoning'
  || (e.type === 'response_item' && e.payload?.channel === 'analysis');
// Raw evidence is an audit envelope, not a second Session parser or semantic Distiller.
// Opaque/private reasoning bodies stay in the local snapshot; only location/size is indexed.
const evidenceRecords = records.map(({ line, event }) => ({ line, timestamp: event.timestamp ?? null,
  type: event.type, payloadType: event.payload?.type ?? null,
  ...(isReasoning(event)
    ? { reasoningBodyOmitted: true, payloadChars: JSON.stringify(event.payload).length }
    : { event }),
}));
const calls = records.filter(r => isCall(r.event));
const results = records.filter(r => isResult(r.event));
const toolPairs = calls.map(({ line, event }) => ({ callLine: line, callId: event.payload.call_id ?? null,
  name: event.payload.name, namespace: event.payload.namespace ?? null,
  resultLines: results.filter(r => r.event.payload.call_id === event.payload.call_id).map(r => r.line) }));
const messageLines = pointers(e => e.type === 'response_item' && e.payload?.type === 'message');
const totalSamples = context => context.toolSummaries.reduce((a, t) => a + t.samples.length, 0);
const metadata = records.find(r => r.event.type === 'session_meta')?.event.payload;
const lastTimestamp = records.filter(r => r.event.timestamp).at(-1)?.event.timestamp;
const sections = standard.markdown.split(/(?=^## )/m).map(s => ({
  heading: s.split('\n')[0], chars: s.length, bytes: Buffer.byteLength(s),
}));
const fidelityWarnings = [
  'Discovery lines is 0 for lightweight or >1 MiB sessions; it is not a message count.',
  'Discovery updatedAt for >1 MiB uses filesystem mtime; capture records the transcript tail independently.',
  'standard recentMessages is a selected window, not the full conversation; full preset also caps at 50.',
  'Expanded config cannot remove hardcoded unknown-tool sample limit 5, custom tool summary 80 chars, MCP params/results 100 chars, compact summary 500 chars, or first-5 reasoning highlights.',
  'Codex pendingTasks is initialized empty and never populated; [] means unsupported extraction, not no remaining work.',
  'Codex timeline contains conversation/lifecycle only; tool calls/results remain in evidence line indices.',
  'Wrapped custom_tool_call exec inputs contain nested tool code; continues does not interpret nested shell/patch results or file modifications.',
  'filesModified represents parser heuristics/attempts, not verified successful writes or the current Git diff.',
  'Native archived_sessions directory is absent. Isolated real-data layout probe is not proof of native archived history.',
  'Current live development checkpoint is a limited self-sample, not an independent completed historical development session.',
  'Reasoning body contents are not promoted to Distiller input. No encrypted reasoning is decoded.',
  'Current Git state is a separate observation; recorded session branch/SHA may be absent or stale.',
  'The last token_usage_record can be newer than token_count. continues ignores token_usage_record, so its cumulative usage may lag at a live checkpoint.',
  'A tool call without a result at the capture boundary is in-flight/unknown, not a failure or a completed operation.',
];
const git = args => execFileSync('git', args, { cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
const before = JSON.parse(fs.readFileSync(path.join(root, 'git-before.json'), 'utf8').replace(/^\uFEFF/, ''));
const preserved = before.files.map(f => ({ path: f.path, unchanged: fs.existsSync(path.join(workspace, f.path))
  && sha256(fs.readFileSync(path.join(workspace, f.path))).toLowerCase() === f.sha256.toLowerCase() }));
const evidence = {
  schemaVersion: 'margin.phase0.evidence.v1', capture, upstream: {
    repository: 'https://github.com/yigitkonur/cli-continues',
    researchedCommit: 'e486cd22a592d89d890cff056624647fbe9cbe80', packageVersion: '4.1.1',
    npmIntegrity: 'sha512-RYpUoZize6iEFzz/rqg7krbI5/2JJGK6uxB/mWYbvZEARaQ36IgLvD2QCg1JorQOgHIMogDhnSB1eSiUZ23GlA==',
    runtime: process.version,
  },
  originalSessionMetadata: metadata,
  recordCounts: tally(records.map(r => `${r.event.type}:${r.event.payload?.type || ''}`)),
  indices: { conversation: messageLines, toolPairs,
    tokenUsage: pointers(e => e.type === 'event_msg' && e.payload?.type === 'token_count'),
    tokenUsageRecords: pointers(e => e.type === 'token_usage_record'),
    turnContext: pointers(e => e.type === 'turn_context'),
    compaction: pointers(e => e.type === 'compacted'), reasoning: pointers(isReasoning),
    lifecycle: pointers(e => e.type === 'event_msg' && /^(task_started|task_complete|turn_aborted|turn_completed)$/.test(e.payload?.type)),
  },
  records: evidenceRecords,
  measurements: { records: records.length, messageRecords: messageLines.length,
    rawToolCalls: calls.length, rawToolResults: results.length,
    rawToolNames: tally(calls.map(r => r.event.payload.name)),
    standardMessages: standard.recentMessages.length, expandedMessages: expanded.recentMessages.length,
    standardSamples: totalSamples(standard), expandedSamples: totalSamples(expanded),
    standardChars: standard.markdown.length, standardBytes: Buffer.byteLength(standard.markdown),
    sections, lastTranscriptTimestamp: lastTimestamp,
    standardHasLatestAssistant: standard.recentMessages.at(-1)?.content === expanded.recentMessages.at(-1)?.content,
    maximumRecordChars: Math.max(...physicalLines.map(l => l.length)),
  },
  extractionConfig: config, fidelityWarnings,
  workspaceObservation: { capturedAt: new Date().toISOString(), head: git(['rev-parse', 'HEAD']),
    branch: git(['branch', '--show-current']), status: git(['status', '--porcelain=v1']), preserved },
};
writeJson('baseline-context.json', { ...expanded, phase0Evidence: evidence });
writeJson('measurements.json', { ...evidence.measurements, fidelityWarnings, preserved });
fs.writeFileSync(path.join(output, 'baseline-session-info.md'), `# Phase 0 真实 Session 基线

- Session ID: \`${session.id}\`
- 来源: Codex Desktop / Codex JSONL，当前真实开发任务的未结束 checkpoint
- Workspace: \`${session.cwd}\`
- Branch / Git SHA（Session 记录）: \`${session.branch ?? '未记录'}\` / \`${session.gitSha ?? '未记录'}\`
- Created: ${session.createdAt.toISOString()}
- Discovery Updated: ${session.updatedAt.toISOString()}（大于 1 MiB 时取文件 mtime，非可靠末次活动）
- 最后原始记录时间: ${lastTimestamp}
- 原文件: \`${capture.originalPath}\`
- 冻结副本: \`${snapshotPath}\`
- 冻结时间: ${capture.capturedAt}
- 冻结字节数: ${capture.bytes}；SHA-256: \`${capture.sha256}\`
- 原始 JSONL 记录数: ${records.length}；message 记录 ${messageLines.length}（含 bootstrap/developer，不等于用户对话数）
- continues 对话: standard ${standard.recentMessages.length}；提高配置上限后 ${expanded.recentMessages.length}
- 原始工具调用 / 返回: ${calls.length} / ${results.length}；standard 工具样本: ${totalSamples(standard)}
- continues filesModified / pendingTasks: ${expanded.filesModified.length} / ${expanded.pendingTasks.length}，不能理解为没有修改或待办
- standard Handoff: ${standard.markdown.length} JavaScript 字符、${Buffer.byteLength(standard.markdown)} UTF-8 字节（未使用 tokenizer，不将字符估算冒充 Token）

## Discovery 与选择依据

本机默认目录发现 ${sessions.length} 条真实 Session；另外两条是论文修改与代理咨询。当前任务是唯一 Margin 开发 Session，包含依赖安装、失败命令、实验文件补丁和验证操作。未发现其他历史开发样本；这不是独立历史样本，不能外推接力质量。无原生 archived_sessions 目录，归档兼容性只进行隔离副本布局探针，见 verification.json。

## 数据边界

baseline-context.json 顶层为公开 extractContext 的扩大上限结果；phase0Evidence 是逐行原始证据与索引，不是上游原生字段，也未实现 Distiller。完整可见对话、工具输入和返回、session_meta、world_state、turn_context、token_count、token_usage_record 及生命周期均能按行回溯。reasoning 仅记位置与大小，不解密或提升为开发状态；原样本没有 compacted 记录。

baseline-continues-handoff.md 是 standard.markdown 原样写入；唯一实验输入调整是 originalPath 指向冻结副本，以免活动 Session 变化使输出无法复现。原位置和副本哈希均在 capture.json 和 Context 中保存。

## Fidelity

${fidelityWarnings.map(w => '- ' + w).join('\n')}

## 复现与结论

依赖 continues 4.1.1（锁文件固定），Node ${process.version}。默认重跑复用冻结副本，使用 --refresh 才更新 checkpoint。原 Session 只读，产物不自动提交。API、具体遗漏、证据行号、下一步唯一验证问题见上一级 README.md；针对本次实验的校验结果见 verification.json。
`);
console.log(JSON.stringify(evidence.measurements, null, 2));
