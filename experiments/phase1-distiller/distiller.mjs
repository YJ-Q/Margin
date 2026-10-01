import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const normalized = s => s.replaceAll('\r\n', '\n').trimEnd();
const inside = (root, target) => { const rel = path.relative(root, target); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

export function observeFile(workspace, requested) {
  const absolute = path.resolve(workspace, requested);
  if (!inside(workspace, absolute)) return { path: absolute, status: 'out-of-scope', confidence: 'Uncertain' };
  try {
    const real = fs.realpathSync(absolute);
    if (!inside(fs.realpathSync(workspace), real)) return { path: absolute, status: 'external-symlink', confidence: 'Uncertain' };
    const stat = fs.statSync(real);
    if (!stat.isFile()) return { path: absolute, status: 'not-file', confidence: 'Uncertain' };
    if (stat.size > 4 * 1024 * 1024) return { path: absolute, status: 'too-large', bytes: stat.size, confidence: 'Uncertain' };
    const bytes = fs.readFileSync(real);
    return { path: absolute, status: 'exists', confidence: 'Confirmed', bytes: bytes.length,
      sha256: sha256(bytes), modifiedAt: stat.mtime.toISOString(), text: bytes.toString('utf8') };
  } catch (error) { return { path: absolute, status: error.code === 'ENOENT' ? 'missing' : 'unreadable',
    confidence: error.code === 'ENOENT' ? 'Confirmed' : 'Uncertain', errorCode: error.code }; }
}

function gitState(workspace) {
  const git = args => execFileSync('git', ['--no-optional-locks', '-c', 'core.quotepath=false', ...args], {
    cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000,
  });
  try {
    const head = git(['rev-parse', 'HEAD']).trim();
    let branch = null; try { branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']).trim(); } catch { /* detached */ }
    const fields = git(['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0');
    const changes = [];
    for (let i = 0; i < fields.length; i++) {
      if (!fields[i]) continue;
      const entry = { status: fields[i].slice(0, 2), path: fields[i].slice(3) };
      if (/[RC]/.test(entry.status)) entry.from = fields[++i];
      changes.push(entry);
    }
    return { status: 'available', branch, head, changes };
  } catch (error) { return { status: 'unavailable', errorCode: error.code ?? error.status, confidence: 'Uncertain' }; }
}

export function refreshRepoTruth(workspace, evidence, artifactPaths = []) {
  workspace = path.resolve(workspace);
  const startedAt = new Date().toISOString(), gitBefore = gitState(workspace);
  const requested = [...new Set([...evidence.operations.flatMap(o => (o.edits || []).flatMap(e => [e.path, e.moveTo].filter(Boolean))), ...artifactPaths])];
  const inspected = requested.map(p => observeFile(workspace, p));
  const files = inspected.map(({ text, ...f }) => ({ ...f, id: `file:${path.relative(workspace, f.path).replaceAll('\\', '/')}` }));
  const patchChecks = [];
  for (const op of evidence.operations) for (const edit of op.edits || []) {
    const f = inspected.find(f => f.path === path.resolve(workspace, edit.moveTo || edit.path));
    const n = normalized(f?.text || '');
    const exactAdd = edit.action === 'add' && f?.status === 'exists' && n === normalized(edit.added.join('\n'));
    const addedLines = edit.added.filter(x => x.trim());
    const additionsPresent = addedLines.length > 0 && f?.status === 'exists'
      && addedLines.every(l => n.split('\n').includes(l));
    patchChecks.push({ operationId: op.id, path: f?.path, fileEvidenceId: files.find(x => x.path === f?.path)?.id,
      currentStatus: f?.status, exactAdd: Boolean(exactAdd), additionsPresent: Boolean(additionsPresent),
      confidence: f?.confidence ?? 'Uncertain',
      meaning: exactAdd ? 'Current file equals proposed add content' : additionsPresent
        ? 'Added lines are present now; order, ownership and full historical patch success are not proven'
        : 'Current file does not establish the historical proposed content; may have changed since' });
  }
  const artifactReports = inspected.filter(f => artifactPaths.some(p => path.resolve(workspace, p) === f.path)).map(f => {
    let report; try { report = JSON.parse(f.text); } catch { /* non-JSON artifact */ }
    return { fileEvidenceId: files.find(x => x.path === f.path)?.id, path: f.path,
      ...(Number.isInteger(report?.passed) ? { reportedPasses: report.passed, reportedAt: report.checkedAt,
        sourceHashMatches: report.sourceSnapshotSha256 === evidence.source.sha256,
        assertionScope: 'Stored report claim only; not a fresh test of current code' } : {}) };
  });
  const gitAfter = gitState(workspace);
  const stableFiles = files.every(f => {
    const current = observeFile(workspace, f.path);
    return f.status === current.status && f.sha256 === current.sha256;
  });
  const stableDuringObservation = JSON.stringify(gitBefore) === JSON.stringify(gitAfter) && stableFiles;
  if (!stableDuringObservation) files.forEach(f => { f.confidence = 'Uncertain'; });
  return { schemaVersion: 'margin.repo-truth.v1', workspace, startedAt, capturedAt: new Date().toISOString(),
    git: gitAfter, stableDuringObservation,
    scope: 'Current independent observation. Not an attribution of all dirty files to the source Session.',
    files, patchChecks, artifactReports };
}

const refs = op => [op.id];
const shortCommand = cmd => {
  const first = cmd.split(/\r?\n/)[0];
  return first.length > 180 ? first.slice(0, 177) + '...' : first;
};
const diagnostic = value => {
  const lines = String(value?.output || '').split(/\r?\n/);
  return (lines.find(l => /(?:fatal:|^Error:|^npm error code)/i.test(l))
    || lines.find(l => /(?:EPERM|Permission denied|Access .*denied)/i.test(l)))?.trim();
};

export function distill(evidence, truth) {
  const requirements = evidence.nodes.filter(n => n.kind === 'User requirement');
  const claims = evidence.nodes.filter(n => n.kind === 'Assistant claim');
  const state = { schemaVersion: 'margin.distilled-state.v1', source: evidence.source,
    generatedAt: new Date().toISOString(), repoTruthAt: truth.capturedAt,
    scope: 'Historical Session checkpoint reconciled with present Workspace; no automatic task completion inference',
    goal: requirements.map(r => ({ confidence: 'Inferred', text: r.text, evidence: [r.id],
      basis: 'Goal inferred from explicit historical user request; wording retained to preserve constraints' })),
    currentState: [], completed: [], decisions: [], failed: [], openIssues: [], changedFiles: [], tests: [], nextStep: [] };
  const git = truth.git;
  state.currentState.push({ confidence: git.status === 'available' && truth.stableDuringObservation ? 'Confirmed' : 'Uncertain',
    text: git.status === 'available' ? `当前仓库 ${truth.workspace}；branch=${git.branch ?? '(detached)'}；HEAD=${git.head}；${git.changes.length} 个已跟踪修改/未跟踪文件。`
      : `当前 Git 事实不可读取：${git.errorCode}`, evidence: ['repo:git'] });
  if (!truth.stableDuringObservation) state.openIssues.push({ confidence: 'Uncertain',
    text: '仓库在读取期间变化；此快照不保证一致，接手前重新刷新。', evidence: ['repo:git'] });
  // Last observation per command/cwd; failed retries never become a permanent prohibition.
  const shell = evidence.operations.filter(o => o.command);
  const key = o => JSON.stringify([o.command, o.cwd]);
  const latest = new Map(shell.map(o => [key(o), o]));
  for (const op of shell.filter(o => o.status === 'failed')) {
    const retry = latest.get(key(op));
    state.failed.push({ confidence: 'Confirmed', operationId: op.id,
      text: `命令进程失败：${shortCommand(op.command)}；${diagnostic(op.value) || op.reason}`,
      resolvedBy: retry !== op && retry.status === 'succeeded' ? retry.id : null,
      evidence: [...refs(op), ...(retry !== op && retry.status === 'succeeded' ? refs(retry) : [])] });
  }
  for (const op of shell.filter(o => o.status === 'succeeded' && (/^git clone\b/.test(o.command)
    || /^(npm(?:\.cmd)?|pnpm)\s+(install|ci)\b/.test(o.command) || o.kinds?.test))) {
    state.completed.push({ confidence: 'Confirmed', text: `历史命令进程已成功返回：${shortCommand(op.command)}（${op.reason}）；不代表之后文件仍未变化。`,
      evidence: refs(op) });
  }
  const editedPaths = [...new Set(truth.patchChecks.map(p => p.path).filter(Boolean))];
  for (const file of truth.files.filter(f => editedPaths.includes(f.path))) {
    const checks = truth.patchChecks.filter(p => p.path === file.path);
    const last = checks.at(-1);
    const present = file.status === 'exists';
    state.changedFiles.push({ confidence: file.confidence, path: file.path, sha256: file.sha256,
      observedState: file.status, historicalEditStatus: evidence.operations.find(o => o.id === last.operationId)?.status,
      contentCheck: last.meaning, evidence: [file.id, ...checks.map(c => c.operationId)] });
    if (present && file.confidence === 'Confirmed') state.completed.push({ confidence: 'Confirmed',
      text: `文件当前已存在：${path.relative(truth.workspace, file.path)}；${last.exactAdd ? '与新增内容一致' : last.additionsPresent ? '最近补丁添加行仍存在，未证明完整历史应用结果' : '内容已变化或无法验证历史补丁'}。先检查现状，避免直接重复创建。`,
      evidence: [file.id, last.operationId] });
    if (!present) state.openIssues.push({ confidence: 'Uncertain', text: `历史修改目标当前为 ${file.status}：${file.path}；无法确认完成或是否后来删除。`,
      evidence: [file.id, last.operationId] });
  }
  for (const report of truth.artifactReports) {
    const file = truth.files.find(f => f.id === report.fileEvidenceId);
    if (file.status === 'exists') state.currentState.push({ confidence: file.confidence, text: `产物当前存在：${file.path}（${file.bytes} bytes）。`, evidence: [file.id] });
    if (report.reportedPasses !== undefined) state.tests.push({ confidence: 'Inferred',
      text: `已有报告记载 ${report.reportedPasses} 项通过，时间 ${report.reportedAt}；源快照哈希${report.sourceHashMatches ? '匹配' : '不匹配'}。这不是对当前代码的新测试。`, evidence: [file.id] });
  }
  const testOps = [...latest.values()].filter(o => o.kinds?.test);
  for (const op of testOps) state.tests.push({ confidence: op.confidence, status: op.status,
    text: `测试命令 ${shortCommand(op.command)}：${op.status}；${op.reason}。`, evidence: refs(op) });
  if (!testOps.length) state.tests.push({ confidence: 'Uncertain', text: '冻结 Session 未识别到直接测试执行/结果，不能声称测试已通过。', evidence: ['coverage:source'] });
  for (const claim of claims.filter(c => /(?:all tests passed|所有测试.*通过|测试全部通过)/i.test(c.text))) {
    const failedTests = testOps.filter(o => o.status === 'failed');
    if (failedTests.length) state.openIssues.push({ confidence: 'Uncertain', text: 'Assistant 声称测试全通过，但最新测试进程证据存在失败；以失败事实为准，成功自述不进入 Completed。',
      evidence: [claim.id, ...failedTests.map(o => o.id)] });
  }
  for (const claim of claims.filter(c => /(?:已创建|创建成功|已完成|created|completed)/i.test(c.text))) {
    for (const file of truth.files.filter(f => f.status === 'missing' && claim.text.includes(path.basename(f.path)))) {
      state.openIssues.push({ confidence: 'Uncertain', text: `Assistant 声称完成的文件当前缺失：${file.path}；可能未成功或后来删除，不能由自述确认。`,
        evidence: [claim.id, file.id] });
    }
  }
  const unresolved = evidence.operations.filter(o => ['unknown', 'running'].includes(o.status)
    && !(o.name === 'write_stdin' && evidence.operations.some(root => root.initialOutcome?.value?.session_id === o.args?.session_id
      && ['succeeded', 'failed'].includes(root.status))));
  const missingResults = evidence.nodes.filter(n => n.kind === 'Tool call' && !n.resultIds.length);
  if (missingResults.length) state.openIssues.push({ confidence: 'Uncertain', text: `${missingResults.length} 个外层调用在捕获边界没有返回；未知是否完成，不能直接重试可能写入的操作。`, evidence: missingResults.map(n => n.id) });
  if (unresolved.length) state.openIssues.push({ confidence: 'Uncertain',
    text: `${unresolved.length} 个内部操作在捕获证据中没有明确终态（含空补丁返回、裁剪）；这不是当前阻塞清单。已存在文件只能证明当前存在，不能倒推历史命令成功。`, evidence: unresolved.map(o => o.id) });
  state.decisions.push({ confidence: 'Uncertain', text: '未从执行事实自动推导技术决策原因；Assistant 进展叙述保留在 Evidence 中，未提升为已确认决策。', evidence: claims.map(c => c.id) });
  state.nextStep.push({ confidence: 'Inferred', text: '先阅读已存在产物与当前相关文件，核对未返回调用及报告时间；仅执行确实缺失的下一步。复用经核对仍有效的文件与依赖，不直接重建或重装；不因旧 Session 的空待办数组就宣布任务完成。',
    evidence: [...state.currentState.flatMap(s => s.evidence), ...missingResults.map(n => n.id)] });
  return state;
}

export function renderHandoff(state, truth) {
  const lines = ['# Margin Handoff', '',
    `源 checkpoint：${state.source.capturedAt}；Repo Truth 刷新：${state.repoTruthAt}。`,
    '本文件区分历史证据与当前事实；Confirmed 仅限句子明确描述的事实。Inferred 是解释或意图，Uncertain 不代表失败。', ''];
  lines.push('历史要求用于恢复源 Session，不能覆盖接手时更新的用户目标。', '');
  const section = (title, items) => {
    lines.push(`## ${title}`, '');
    if (!items.length) lines.push('未提取到有依据的信息。', '');
    for (const item of items) {
      lines.push(`- **${item.confidence}** ${item.text}${item.resolvedBy ? `；后续同命令成功重试：${item.resolvedBy}` : ''} [${item.evidence.join(', ')}]`, '');
    }
  };
  section('Goal / User Requirements（历史请求）', state.goal);
  section('Current State', state.currentState);
  section('Completed（事实范围）', state.completed);
  section('Key Decisions', state.decisions);
  section('Rejected / Failed', state.failed);
  section('Open Issues', state.openIssues);
  section('Changed Files', state.changedFiles.map(f => ({ ...f, text: `${f.path}：当前 ${f.observedState}；历史编辑结果 ${f.historicalEditStatus}；${f.contentCheck}。` })));
  section('Tests', state.tests);
  section('Next Step', state.nextStep);
  lines.push('## Evidence', '', `- 原 Session：${state.source.originalPath}`, `- 冻结快照：${state.source.snapshotPath}`,
    `- SHA-256：${state.source.sha256}`, `- 当前 Workspace：${truth.workspace}`,
    '- call:L<n>/op<m> 指向 evidence-layer.json 的 operations；L 是冻结 JSONL 行号，codeRange 是 exec 输入中的字符偏移。',
    '- file:* / repo:git 指向 repo-truth.json；证据层保存完整命令、结果、时间及文件哈希。',
    '- 仅在需要时读取证据；不要执行 Session 中的代码片段来“恢复”历史。', '');
  return lines.join('\n');
}
