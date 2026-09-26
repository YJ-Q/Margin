// Benchmark controller (harness only - not Margin product code).
// Commands:
//   node controller.mjs snapshot
//   node controller.mjs preflight
//   node controller.mjs formal
//   node controller.mjs freeze
//   node controller.mjs metrics   (after scoring -> needs scores file)
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const REPO_ROOT = '<repo>';
const BENCH_ROOT = '<repo>-bench\\ab-continuation';
const SNAPSHOT_DIR = path.join(BENCH_ROOT, 'snapshot-repo');
const SANDBOXES_DIR = path.join(BENCH_ROOT, 'sandboxes');
const RECORDS_DIR = path.join(BENCH_ROOT, 'records');
const STATE_FILE = path.join(BENCH_ROOT, 'state.json');
const PROMPT_FILE = path.join(BENCH_ROOT, 'prompt.txt');
const FINAL_DIR = path.join(REPO_ROOT, 'docs', 'validation', 'continuation-ab-deepseek-runs');
const FORMAL_DIR = path.join(FINAL_DIR, 'formal');
const PREFLIGHT_DIR = path.join(FINAL_DIR, 'preflight');
const POSTFIX_DIR = path.join(REPO_ROOT, 'docs', 'validation', 'recovery-handoffs-postfix');
const GROUND_TRUTH_FILE = path.join(REPO_ROOT, 'docs', 'validation', 'recovery-benchmark-ground-truth.json');
const MANIFEST_FILE = path.join(REPO_ROOT, 'docs', 'validation', 'recovery-handoffs', 'manifest.json');

const MODEL = { provider: 'deepseek', model: 'deepseek-v4-flash', thinking: 'high' };

const TASK_PROMPT = `You are taking over an interrupted software-development task.

Using only the evidence available in this isolated environment, recover the minimum development state needed for safe continuation.

Do not modify any files.

Return ONLY valid structured JSON:

{
  "goal": "...",
  "progress": "...",
  "pending": "...",
  "historicalValidation": "...",
  "recommendedFollowUp": "...",
  "currentApplicability": "...",
  "unsafeAssumptions": []
}

Rules:

- distinguish historical reports from current repository truth
- historical test success is not current validation
- assistant-reported completion is not independent current truth
- do not invent missing information
- if information is unsupported, explicitly say unknown
- historical recommendations may be stale
- do not promote a historical recommendation into a definitely executable current action
- stop immediately after returning the recovery JSON
`;

const MANIFEST = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
const CASE_ORDER_A_FIRST = ['case-01', 'case-02', 'case-03', 'case-04', 'case-05', 'case-06'];
const CASE_ORDER_B_FIRST = ['case-07', 'case-08', 'case-09', 'case-10', 'case-11', 'case-12'];
const UUIDS = MANIFEST.artifacts.map((a) => a.session_id);
const CASE_ARTIFACT = {};
for (const a of MANIFEST.artifacts) {
  CASE_ARTIFACT[a.case_id] = { caseId: a.case_id, sessionId: a.session_id, handoffPath: path.join(POSTFIX_DIR, `${a.case_id}.md`) };
}

function sha256File(p) {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase();
}

const GIT_RESOLVE = spawnSync('where.exe', ['git'], { encoding: 'utf8' });
const GIT_BIN_DIRS = GIT_RESOLVE.stdout && GIT_RESOLVE.status === 0
  ? [...new Set(GIT_RESOLVE.stdout.trim().split(/\r?\n/).filter(Boolean).map((l) => path.dirname(l)))].join(';')
  : '';

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(BENCH_ROOT, 'controller.log'), line + '\n');
}

function loadState() {
  if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  return { created: new Date().toISOString(), runs: {}, sessionIds: [] };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function initDirs() {
  for (const d of [BENCH_ROOT, SNAPSHOT_DIR, SANDBOXES_DIR, RECORDS_DIR, FINAL_DIR, FORMAL_DIR, PREFLIGHT_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
  if (!fs.existsSync(PROMPT_FILE)) fs.writeFileSync(PROMPT_FILE, TASK_PROMPT, 'utf8');
}

const FORBIDDEN_NAME = /(recovery-benchmark-ground-truth|recovery-handoffs|margin_(recovery|handoff)_compression_benchmark|margin_recovery_benchmark|margin_continuation|continuation-ab-deepseek-runs|^HANDOFF\.md$|^session-[0-9a-f]{8}-[0-9a-f-]{27,36}\.jsonl$)/i;
const UUID_RE = new RegExp(UUIDS.join('|'), 'i');
const SKIP_SCAN_DIRS = new Set(['.git', 'node_modules']);

// ---- snapshot -------------------------------------------------------------
async function cmdSnapshot() {
  initDirs();
  fs.rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

  const val = path.join(REPO_ROOT, 'docs', 'validation');
  const untrackedBenchFiles = [
    'recovery-benchmark-ground-truth.json',
    'margin_handoff_compression_benchmark.json', 'margin_handoff_compression_benchmark.md',
    'margin_handoff_compression_benchmark_postfix.json', 'margin_handoff_compression_benchmark_postfix.md',
    'margin_handoff_size_results.csv',
    'margin_recovery_benchmark.json', 'margin_recovery_benchmark.md',
    'margin_recovery_benchmark_rerun.json', 'margin_recovery_benchmark_rerun.md'
  ];
  const excludeDirs = [
    // heavy / generated / ignored runtime dirs (excluded by name, any depth)
    'node_modules', 'out', 'out2', 'out-electron', '.runtime', '.margin',
    'handoff-output', '.worktrees', '.claude', '.agents', 'data', 'dist',
    // untracked experiment dirs that carry raw native session copies
    path.join(REPO_ROOT, 'experiments', 'phase0-continues'),
    // untracked experiment dir that carries distilled session-derived handoff output
    path.join(REPO_ROOT, 'experiments', 'phase1-distiller'),
    // benchmark input/output dirs under docs/validation (never expose to tested runs)
    path.join(val, 'recovery-handoffs'),
    path.join(val, 'recovery-handoffs-postfix'),
    path.join(val, 'continuation-ab-deepseek-runs')
  ];
  const excludeFiles = ['.env', ...untrackedBenchFiles.map((f) => path.join(val, f)), path.join(REPO_ROOT, 'scripts', 'generate-postfix-handoff-benchmark.js')];
  const args = [REPO_ROOT, SNAPSHOT_DIR, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1', '/XD', ...excludeDirs, '/XF', ...excludeFiles];
  const r = spawnSync('robocopy', args, { encoding: 'utf8' });
  const code = typeof r.status === 'number' ? r.status : -1;
  if (code >= 8) throw new Error(`robocopy snapshot failed (code ${code}): ${r.stderr || r.stdout}`);

  // keep data/.gitkeep tracked file so the snapshot git status matches the real repo
  fs.mkdirSync(path.join(SNAPSHOT_DIR, 'data'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'data', '.gitkeep'), path.join(SNAPSHOT_DIR, 'data', '.gitkeep'));

  // remove any rollout-style session copies that may exist anywhere inside snapshot
  removeRolloutCopies(SNAPSHOT_DIR);

  const verification = verifyTree(SNAPSHOT_DIR, { nameRule: FORBIDDEN_NAME, uuidCheck: true });
  const gitStatus = spawnSync('git', ['-C', SNAPSHOT_DIR, 'status', '--short'], { encoding: 'utf8' });
  const manifest = {
    frozenAt: new Date().toISOString(),
    head: spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    snapshotGitStatusLines: gitStatus.status === 0 ? gitStatus.stdout.trim().split(/\r?\n/).filter(Boolean) : [],
    repoRoot: REPO_ROOT,
    snapshotDir: SNAPSHOT_DIR,
    excludes: { dirs: excludeDirs.map((d) => (d.startsWith(REPO_ROOT) ? path.relative(REPO_ROOT, d) : d)), files: excludeFiles.map((f) => (f.startsWith(REPO_ROOT) ? path.relative(REPO_ROOT, f) : f)) },
    verification
  };
  fs.writeFileSync(path.join(BENCH_ROOT, 'snapshot-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  log(`snapshot done code=${code} verification=${JSON.stringify(verification)}`);
  return manifest;
}

function removeRolloutCopies(root) {
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && /rollout-.*\.jsonl$/i.test(e.name)) fs.rmSync(p, { force: true });
    }
  };
  walk(root);
}

function verifyTree(root, { nameRule, uuidCheck }) {
  const out = { checkedFiles: 0, forbiddenNameHits: [], uuidHits: [], ok: true };
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_SCAN_DIRS.has(e.name)) continue;
        walk(p);
      } else if (e.isFile()) {
        out.checkedFiles++;
        if (nameRule && nameRule.test(e.name)) out.forbiddenNameHits.push(path.relative(root, p));
        if (uuidCheck && e.size <= 4 * 1024 * 1024) {
          try {
            const head = fs.readFileSync(p);
            const s = head.toString('utf8');
            if (UUID_RE.test(s)) out.uuidHits.push(path.relative(root, p));
          } catch { /* ignore */ }
        }
      }
    }
  };
  walk(root);
  out.ok = out.forbiddenNameHits.length === 0 && out.uuidHits.length === 0;
  return out;
}

// ---- one run --------------------------------------------------------------
async function runOne({ caseId, arm, phase }) {
  const runId = `${phase}-${caseId}-${arm}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const artifact = CASE_ARTIFACT[caseId];
  if (!artifact) throw new Error(`unknown case ${caseId}`);
  const sandboxDir = path.join(SANDBOXES_DIR, `${phase}-${caseId}-${arm}`);
  fs.rmSync(sandboxDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(sandboxDir, 'input'), { recursive: true });
  fs.mkdirSync(path.join(sandboxDir, '_tmp'), { recursive: true });
  fs.mkdirSync(path.join(sandboxDir, 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(sandboxDir, 'README-ENVIRONMENT.md'), [
    '# Isolated recovery environment',
    '',
    '- ./workspace  : a frozen copy of the software repository (inspect only).',
    '- ./input      : the single recovery artifact provided for this run.',
    '',
    'This environment is self-contained and isolated from every other workspace.',
    'Do not modify repository files.'
  ].join('\n'), 'utf8');

  // identical frozen workspace copy for every arm
  const copy = spawnSync('robocopy', [SNAPSHOT_DIR, path.join(sandboxDir, 'workspace'), '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1'], { encoding: 'utf8' });
  if (copy.status >= 8) throw new Error(`sandbox workspace copy failed code=${copy.status}`);

  // arm input artifact
  let inputFile;
  let inputExpectedSha;
  if (arm === 'A') {
    inputFile = path.join(POSTFIX_DIR, `session-${artifact.sessionId}.jsonl`);
    fs.copyFileSync(inputFile, path.join(sandboxDir, 'input', 'session.jsonl'));
    inputExpectedSha = sha256File(inputFile);
  } else {
    inputFile = artifact.handoffPath;
    fs.copyFileSync(inputFile, path.join(sandboxDir, 'input', 'HANDOFF.md'));
    inputExpectedSha = sha256File(inputFile);
  }
  const sandboxInputSha = arm === 'A' ? sha256File(path.join(sandboxDir, 'input', 'session.jsonl')) : sha256File(path.join(sandboxDir, 'input', 'HANDOFF.md'));
  if (sandboxInputSha !== inputExpectedSha) throw new Error('input artifact copy sha mismatch');

  // isolation certificate for this run sandbox
  const cert = {
    runId,
    caseId,
    arm,
    phase,
    sandboxDir,
    workspaceVerification: verifyTree(path.join(sandboxDir, 'workspace'), { nameRule: FORBIDDEN_NAME, uuidCheck: true }),
    inputFolderEntries: fs.readdirSync(path.join(sandboxDir, 'input')),
    inputArtifact: arm === 'A' ? { name: 'session.jsonl', sha256: sandboxInputSha, source: path.basename(inputFile) } : { name: 'HANDOFF.md', sha256: sandboxInputSha, source: path.basename(inputFile) },
    sandboxWideForbiddenHits: scanSandboxForArmViolation(sandboxDir, arm, artifact)
  };
  cert.ok =
    cert.workspaceVerification.ok &&
    cert.inputFolderEntries.length === 1 &&
    cert.sandboxWideForbiddenHits.length === 0;
  fs.writeFileSync(path.join(RECORDS_DIR, `${runId}.cert.json`), JSON.stringify(cert, null, 2), 'utf8');

  const recordFile = path.join(RECORDS_DIR, `${runId}.json`);
  const config = {
    runId,
    caseId,
    arm,
    phase,
    sandboxRoot: sandboxDir,
    promptFile: PROMPT_FILE,
    providerId: MODEL.provider,
    modelId: MODEL.model,
    thinking: MODEL.thinking
  };
  const configFile = path.join(RECORDS_DIR, `${runId}.cfg.json`);
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8');

  // controller-side wall clock
  const startMs = Date.now();
  const workerScript = path.join(FINAL_DIR, '_harness', 'worker.mjs');
  const child = spawn(process.execPath, [workerScript, configFile, recordFile], {
    cwd: REPO_ROOT,
    env: { ...process.env, PI_GLOBAL_NPM_ROOT: process.env.PI_GLOBAL_NPM_ROOT, BENCH_GIT_DIR: GIT_BIN_DIRS }
  });
  let stdout = '';
  let stderr = '';
  let completeAt = null;
  child.stdout.on('data', (d) => { stdout += d.toString('utf8'); if (/RUN_COMPLETE /m.test(stdout) && !completeAt) completeAt = Date.now(); });
  child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
  const watchdog = setTimeout(() => { child.kill('SIGKILL'); }, 25 * 60 * 1000);
  const exitCode = await new Promise((res) => child.on('close', (c) => res(c)));
  clearTimeout(watchdog);

  const endMs = completeAt || Date.now();
  const controllerDurationMs = endMs - startMs;

  let record = null;
  try { record = JSON.parse(fs.readFileSync(recordFile, 'utf8')); } catch { record = null; }
  const ok = record && record.infraStatus === 'ok' && exitCode === 0;
  const enriched = {
    ...(record || { infraStatus: 'error' }),
    controller: { phase, caseId, arm, runId, startMs: new Date(startMs).toISOString(), endMs: new Date(endMs).toISOString(), durationMs: controllerDurationMs, exitCode, workerStdout: stdout.slice(0, 4000), workerStderr: stderr.slice(0, 4000) },
    isolationCertificate: cert.ok ? { ok: true, certPath: path.join(RECORDS_DIR, `${runId}.cert.json`) } : { ok: false, cert }
  };
  if (record && record.infraStatus === 'ok') {
    record.controller = enriched.controller;
    record.isolationCertificate = enriched.isolationCertificate;
    fs.writeFileSync(recordFile, JSON.stringify(record, null, 2), 'utf8');
  }

  const state = loadState();
  state.runs[runId] = { phase, caseId, arm, ok, controllerDurationMs, recordFile, sessionId: record ? record.sessionId : null };
  if (record && record.sessionId) state.sessionIds.push(record.sessionId);
  saveState(state);

  const destDir = phase === 'formal' ? FORMAL_DIR : PREFLIGHT_DIR;
  const destBase = path.join(destDir, `${caseId}-${arm}`);
  fs.copyFileSync(recordFile, `${destBase}.json`);
  fs.copyFileSync(path.join(RECORDS_DIR, `${runId}.cert.json`), `${destBase}.cert.json`);
  fs.writeFileSync(`${destBase}.cfg.json`, JSON.stringify(config, null, 2), 'utf8');
  log(`run ${runId} ok=${ok} controllerDurationMs=${controllerDurationMs} exit=${exitCode}`);

  return { runId, caseId, arm, phase, ok, controllerDurationMs, record };
}

function scanSandboxForArmViolation(sandboxDir, arm, artifact) {
  const hits = [];
  const others = UUIDS.filter((u) => u !== artifact.sessionId);
  const otherUuidRe = new RegExp(others.join('|'), 'i');
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '.git') continue;
        walk(p);
      } else if (e.isFile()) {
        const rel = path.relative(sandboxDir, p).replace(/\\/g, '/');
        if (arm === 'A') {
          if (/HANDOFF\.md$/i.test(p)) hits.push('HANDOFF.md present: ' + rel);
          if (otherUuidRe.test(p) || (e.size <= 8 * 1024 * 1024 && otherUuidRe.test(safeRead(p)))) hits.push('other-case session content: ' + rel);
        } else {
          if (/session-[0-9a-f-]+\.jsonl$/i.test(p)) hits.push('raw session jsonl present: ' + rel);
          if (otherUuidRe.test(p) || (e.size <= 8 * 1024 * 1024 && otherUuidRe.test(safeRead(p)))) hits.push('other-case session content: ' + rel);
        }
      }
    }
  };
  walk(sandboxDir);
  return hits;
}

function safeRead(p) {
  try { return fs.readFileSync(p).toString('utf8'); } catch { return ''; }
}

// ---- run set --------------------------------------------------------------
function runSet(items, phase) {
  return (async () => {
    const state = loadState();
    const results = [];
    for (const it of items) {
      const existing = Object.values(state.runs).filter((r) => r.phase === phase && r.caseId === it.caseId && r.arm === it.arm && r.ok);
      if (existing.length > 0) {
        log(`skip existing ${phase} ${it.caseId}-${it.arm}`);
        results.push({ ...it, ok: true, skipped: true, recordFile: existing[0].recordFile, controllerDurationMs: existing[0].controllerDurationMs });
        continue;
      }
      try {
        const res = await runOne({ caseId: it.caseId, arm: it.arm, phase });
        results.push({ ...it, ok: res.ok, recordFile: res.recordFile, controllerDurationMs: res.controllerDurationMs });
      } catch (e) {
        log(`run failure ${it.caseId}-${it.arm}: ${e.message}`);
        results.push({ ...it, ok: false, error: String(e.message || e) });
      }
    }
    return results;
  })();
}

function formalItems() {
  const items = [];
  for (const c of CASE_ORDER_A_FIRST) { items.push({ caseId: c, arm: 'A' }, { caseId: c, arm: 'B' }); }
  for (const c of CASE_ORDER_B_FIRST) { items.push({ caseId: c, arm: 'B' }, { caseId: c, arm: 'A' }); }
  return items;
}

async function cmdPreflight() {
  initDirs();
  await cmdSnapshotIfMissing();
  const results = await runSet([{ caseId: 'case-01', arm: 'A' }, { caseId: 'case-01', arm: 'B' }], 'preflight');
  fs.writeFileSync(path.join(BENCH_ROOT, 'preflight-summary.json'), JSON.stringify(results, null, 2), 'utf8');
  log('preflight done');
}

async function cmdFormal() {
  initDirs();
  const results = await runSet(formalItems(), 'formal');
  const allOk = results.filter((r) => r.ok).length;
  const failures = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(BENCH_ROOT, 'formal-summary.json'), JSON.stringify({ results, allOk, failures }, null, 2), 'utf8');
  log(`formal done ok=${allOk}/${results.length}`);
}

async function cmdSnapshotIfMissing() {
  if (!fs.existsSync(path.join(BENCH_ROOT, 'snapshot-manifest.json'))) {
    await cmdSnapshot();
  } else {
    log('snapshot exists, reusing');
  }
}

function cmdFreeze() {
  initDirs();
  const manifest = { frozenAt: new Date().toISOString(), files: {} };
  for (const dir of [FORMAL_DIR, PREFLIGHT_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
      manifest.files[path.join(path.basename(dir), f)] = sha256File(path.join(dir, f));
    }
  }
  fs.writeFileSync(path.join(FINAL_DIR, 'freeze-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  log('freeze done');
  return manifest;
}

function cmdMetrics() {
  // Reads frozen formal records + scores + ground truth and writes final deliverables.
  // Implemented separately (report writer) - see report.mjs
  console.error('metrics phase implemented in report.mjs');
  process.exit(2);
}

const command = process.argv[2];
switch (command) {
  case 'snapshot': cmdSnapshot().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); }); break;
  case 'preflight': cmdPreflight().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); }); break;
  case 'formal': cmdFormal().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); }); break;
  case 'freeze': cmdFreeze(); process.exit(0); break;
  case 'metrics': cmdMetrics(); break;
  default: console.error('unknown command'); process.exit(2);
}
