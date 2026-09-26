import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEncoding } from 'js-tiktoken';
import { buildEvidence } from './evidence.mjs';
import { distill, refreshRepoTruth, renderHandoff, sha256 } from './distiller.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(root, '../..');
const inputPath = path.resolve(workspace, 'experiments/phase0-continues/output/baseline-context.json');
const input = fs.readFileSync(inputPath);
const context = JSON.parse(input);
const source = context.phase0Evidence.capture;
const frozen = fs.readFileSync(source.snapshotPath);
if (sha256(frozen) !== source.sha256) throw Error('Phase 0 snapshot hash mismatch');
const evidence = buildEvidence(context);
evidence.input = { path: inputPath, sha256: sha256(input) };
const output = path.join(root, 'output');
fs.mkdirSync(output, { recursive: true });
const write = (name, data) => fs.writeFileSync(path.join(output, name), JSON.stringify(data, null, 2));
const phase0Output = path.dirname(inputPath);
const artifactPaths = ['baseline-context.json', 'baseline-continues-handoff.md', 'baseline-session-info.md', 'verification.json']
  .map(f => path.join(phase0Output, f));
// Refresh on EVERY generation, even with an unchanged historical checkpoint.
const truth = refreshRepoTruth(workspace, evidence, artifactPaths);
evidence.nodes.push({ id: 'repo:git', kind: 'Git state', confidence: truth.git.status === 'available' ? 'Confirmed' : 'Uncertain',
  evidence: [{ path: path.join(output, 'repo-truth.json'), capturedAt: truth.capturedAt }] },
{ id: 'coverage:source', kind: 'Source coverage', confidence: 'Confirmed', counts: evidence.coverage,
  evidence: [{ path: source.snapshotPath, sha256: source.sha256 }] },
...truth.files.map(f => ({ id: f.id, kind: 'Workspace state', confidence: f.confidence,
  evidence: [{ path: f.path, sha256: f.sha256, capturedAt: truth.capturedAt }], status: f.status })));
const state = distill(evidence, truth);
const handoff = renderHandoff(state, truth);
const knownIds = new Set([...evidence.nodes.map(n => n.id), ...evidence.operations.map(o => o.id)]);
for (const items of Object.values(state).filter(Array.isArray)) for (const fact of items) {
  if (!fact.evidence?.length || fact.evidence.some(id => !knownIds.has(id))) throw Error('Unresolvable distilled fact evidence');
  if (!['Confirmed', 'Inferred', 'Uncertain'].includes(fact.confidence)) throw Error('Missing confidence label');
}
const before = JSON.parse(fs.readFileSync(path.join(root, 'git-before.json'), 'utf8').replace(/^\uFEFF/, ''));
const preservation = [...before.files, ...before.phase0Artifacts].map(f => ({ path: f.path,
  unchanged: sha256(fs.readFileSync(path.resolve(workspace, f.path))) === f.sha256.toLowerCase() }));
if (preservation.some(p => !p.unchanged)) throw Error('A pre-existing file changed; inspect before overwriting reports');
const enc = getEncoding('o200k_base');
const count = text => enc.encode(text, [], []).length;
const standard = fs.readFileSync(path.join(phase0Output, 'baseline-continues-handoff.md'), 'utf8');
const visibleToolInput = context.phase0Evidence.records.flatMap(r => {
  const p = r.event?.payload;
  if (r.event?.type !== 'response_item') return [];
  if (p?.type === 'message' && ['user', 'assistant'].includes(p.role)) {
    const text = p.content?.filter(c => c.text).map(c => c.text).join('\n') || '';
    return /^\s*(?:<recommended_plugins>|<environment_context>|<permissions|# AGENTS\.md)/.test(text) ? [] : [text];
  }
  if (['custom_tool_call', 'function_call'].includes(p?.type)) return [p.input || p.arguments || ''];
  if (['custom_tool_call_output', 'function_call_output'].includes(p?.type)) return [typeof p.output === 'string' ? p.output
    : Array.isArray(p.output) ? p.output.filter(c => c.text).map(c => c.text).join('\n') : JSON.stringify(p.output)];
  return [];
}).join('\n');
const measurements = { capturedAt: new Date().toISOString(), tokenizer: 'js-tiktoken 1.0.21 / o200k_base',
  interpretation: 'Consistent offline encoding, not an assertion about GPT-6 billing or exact runtime tokenizer',
  rawSession: { bytes: frozen.length, tokens: count(frozen.toString('utf8')) },
  phase0Context: { bytes: input.length, tokens: count(input.toString('utf8')) },
  continuesStandard: { bytes: Buffer.byteLength(standard), tokens: count(standard) },
  marginHandoff: { bytes: Buffer.byteLength(handoff), tokens: count(handoff) },
  visibleConversationAndTools: { bytes: Buffer.byteLength(visibleToolInput), tokens: count(visibleToolInput),
    note: 'Excludes private reasoning, developer/bootstrap records, world state, and plugin recommendations; retains complete visible tool payload text' },
  contentOnlySession: { tokens: count(context.recentMessages.map(m => m.content).join('\n')),
    note: 'Conversation-only comparison; excludes the tool evidence needed to recover execution facts' },
  evidenceCoverage: evidence.coverage, nestedOperations: evidence.operations.length,
  outcomes: Object.fromEntries(['succeeded', 'failed', 'running', 'unknown'].map(s => [s, evidence.operations.filter(o => o.status === s).length])),
  distilledCounts: Object.fromEntries(Object.entries(state).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length])),
  repoStableDuringObservation: truth.stableDuringObservation, preservation };
measurements.handoffFractionOfRawTokens = measurements.marginHandoff.tokens / measurements.rawSession.tokens;
measurements.handoffFractionOfVisibleToolTokens = measurements.marginHandoff.tokens / measurements.visibleConversationAndTools.tokens;
write('evidence-layer.json', evidence);
write('repo-truth.json', truth);
write('distilled-state.json', state);
fs.writeFileSync(path.join(output, 'margin-handoff.md'), handoff);
write('measurements.json', measurements);
console.log(JSON.stringify({ ...measurements, preservation: { checked: preservation.length,
  unchanged: preservation.filter(p => p.unchanged).length } }, null, 2));
