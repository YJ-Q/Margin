#!/usr/bin/env node
// Regenerates a separately named, traceable postfix artifact set. Frozen
// recovery-handoffs and baseline benchmark files are intentionally read-only.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { captureSession, generateHandoff } from '../src/core/handoff/index.js';

const root = process.cwd();
const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
const baseline = JSON.parse(fs.readFileSync(path.join(root, 'docs/validation/recovery-handoffs/manifest.json'), 'utf8'));
const groundTruthPath = path.join(root, 'docs/validation/recovery-benchmark-ground-truth.json');
const groundTruth = JSON.parse(fs.readFileSync(groundTruthPath, 'utf8'));
const requestedCases = option('--cases')?.split(',').map(value => value.trim()).filter(Boolean);
const outputOption = option('--output');
const outputDir = outputOption ? path.resolve(root, outputOption) : path.join(root, 'docs/validation/recovery-handoffs-postfix');
if (args.length && (!outputOption || !requestedCases?.length)) throw Error('Use --output <new-directory> --cases <case-01,case-02>.');
if (outputOption && fs.existsSync(outputDir)) throw Error(`Refusing to overwrite existing iteration directory: ${outputDir}`);
const archiveRoot = path.join(process.env.USERPROFILE, '.codex', 'archived_sessions');
const sourceFor = id => {
  const found = fs.readdirSync(archiveRoot).find(name => name.endsWith(`${id}.jsonl`));
  if (!found) throw Error(`Retained native session not found: ${id}`);
  return path.join(archiveRoot, found);
};
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const median = values => { const sorted = [...values].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
const mean = values => values.reduce((total, value) => total + value, 0) / values.length;

const selected = requestedCases
  ? baseline.artifacts.filter(artifact => requestedCases.includes(artifact.case_id))
  : baseline.artifacts;
if (requestedCases && selected.length !== requestedCases.length) throw Error('One or more requested cases are absent from the frozen manifest.');
fs.mkdirSync(outputDir, { recursive: true });
const cases = selected.map((artifact, index) => {
  const originalPath = sourceFor(artifact.session_id);
  const snapshotPath = path.join(outputDir, `session-${artifact.session_id}.jsonl`);
  const stat = fs.statSync(originalPath);
  const capture = captureSession({ id: artifact.session_id, cwd: root, originalPath }, snapshotPath, { refreshSnapshot: true });
  const { markdown } = generateHandoff(capture, root);
  const handoffPath = path.join(outputDir, `${artifact.case_id}.md`);
  fs.writeFileSync(handoffPath, `<!-- benchmark-case: ${artifact.case_id} | session-id: ${artifact.session_id} | workspace-repo: ${root} -->\n${markdown}`);
  const handoffBytes = fs.statSync(handoffPath).size;
  return { case: artifact.case_id, sessionId: artifact.session_id, sourceSnapshot: originalPath, sourceBytes: stat.size,
    sourceSha256: hash(originalPath), handoff: path.relative(root, handoffPath).replace(/\\/g, '/'), handoffBytes,
    handoffSha256: hash(handoffPath), reductionPct: 100 * (1 - handoffBytes / stat.size) };
});
const sourceBytes = cases.map(item => item.sourceBytes), handoffBytes = cases.map(item => item.handoffBytes), reductions = cases.map(item => item.reductionPct);
const artifact = { schema_version: 1, status: 'complete', method: 'Postfix outputs were generated through capture → evidence → repo truth → distill → handoff from retained native sessions. Semantic comparison remains a human review against the frozen ground truth; no benchmark-specific extraction rules are used.',
  frozenInputs: { baselineManifest: 'docs/validation/recovery-handoffs/manifest.json', groundTruth: path.relative(root, groundTruthPath).replace(/\\/g, '/'), groundTruthSha256: hash(groundTruthPath), baselineCaseCount: baseline.artifacts.length, groundTruthCaseCount: groundTruth.cases.length },
  cases, statistics: { sourceBytes: { median: median(sourceBytes), mean: mean(sourceBytes) }, handoffBytes: { median: median(handoffBytes), mean: mean(handoffBytes) }, reductionPct: { median: median(reductions), mean: mean(reductions), min: Math.min(...reductions), max: Math.max(...reductions) } } };
const reportPath = outputOption
  ? path.join(outputDir, 'manifest.json')
  : path.join(root, 'docs/validation/margin_handoff_compression_benchmark_postfix.json');
fs.writeFileSync(reportPath, JSON.stringify(artifact, null, 2) + '\n');
console.log(JSON.stringify({ cases: cases.length, statistics: artifact.statistics }, null, 2));
