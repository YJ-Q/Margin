// Disposable launch smoke: starts ONE worker child, times it controller-side,
// enforces a 120s diagnostic kill, and reports which stage completed.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = '<repo>-bench\\ab-continuation\\diag';
const cfgFile = path.join(root, 'cfg.json');
const recordFile = path.join(root, 'record.json');
const worker = path.join('<repo>', 'docs', 'validation', 'continuation-ab-deepseek-runs', '_harness', 'worker.mjs');
// rewrite files without BOM (defensive; controller normally writes with fs.writeFileSync)
fs.writeFileSync(path.join(root, 'prompt.txt'), 'Reply with exactly one word: READY', 'utf8');
fs.writeFileSync(cfgFile, JSON.stringify({
  runId: 'diag-smoke-001', caseId: 'case-01', arm: 'A', phase: 'diag',
  sandboxRoot: root, promptFile: path.join(root, 'prompt.txt'),
  providerId: 'deepseek', modelId: 'deepseek-v4-flash', thinking: 'high'
}), 'utf8');
const child = spawn(process.execPath, [worker, cfgFile, recordFile], {
  cwd: '<repo>',
  env: { ...process.env, PI_GLOBAL_NPM_ROOT: process.env.PI_GLOBAL_NPM_ROOT }
});
const t0 = Date.now();
let stdout = '';
let complete = false;
child.stdout.on('data', (d) => { stdout += d.toString(); if (/RUN_COMPLETE /m.test(stdout) || /RUN_ERROR /m.test(stdout)) complete = true; });
child.stderr.on('data', (d) => { stdout += '[stderr] ' + d.toString(); });
const watchdog = setTimeout(() => { console.log(`KILL at ${Date.now() - t0}ms (diagnostic 120s)`); child.kill('SIGKILL'); }, 120000);
child.on('close', (code) => {
  clearTimeout(watchdog);
  const dur = Date.now() - t0;
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(recordFile, 'utf8')); } catch { }
  console.log(`close code=${code} durMs=${dur} complete=${complete}`);
  console.log(`record: infraStatus=${rec ? rec.infraStatus : 'MISSING'} sessionId=${rec ? rec.sessionId : 'n/a'} durationMs=${rec ? rec.durationMs : 'n/a'}`);
  console.log('worker stdout tail:', stdout.slice(-500));
  process.exit(0);
});
