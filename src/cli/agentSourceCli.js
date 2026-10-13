import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readAgentSourceRegistry, writeAgentSourceRegistry, detectAgentSources, registerAgentSource, removeAgentSource, enableAgentSource, validateSource, registryPath, defaultSourcePaths, descriptorProblems } from '../agents/sourceRegistry.js';
import { resolveActiveSource } from '../agents/sourceRegistry.js';
import { installAgentDescriptor, uninstallAgentDescriptor } from '../agents/agentInstall.js';
import { DEFAULT_SAMPLE, MAX_SAMPLE, formatVerifyResult, verifyAgentDescriptor, verifyExitCode, verifyManifestError } from '../agents/agentVerify.js';

const write = (stream, text) => stream.write(`${text}\n`);
const flag = (argv, name) => argv.includes(name);

function formatSource(source, registry, options) {
  const active = resolveActiveSource(registry, source.agentType, options)?.sourceId === source.sourceId ? ' active' : '';
  const validation = validateSource(source).valid ? '' : ' (path unavailable)';
  const supported = Object.entries(source.capabilities ?? {}).filter(([, enabled]) => enabled).map(([name]) => name).join(',') || 'none';
  const removed = source.suppressed ? ' removed' : '';
  return `${source.sourceId}\t${source.agentType}\t${source.name}\t${source.home}\t${source.origin}\t${source.enabled ? 'enabled' : 'disabled'}\tcapabilities:${supported}${active}${removed}${validation}`;
}

// `install` reads a descriptor the Agent fetched; it never fetches anything itself.
function readDescriptorArgument(argument, stdin) {
  if (argument === '-') return JSON.parse(String(stdin ?? ''));
  return JSON.parse(fs.readFileSync(argument, 'utf8').replace(/^\uFEFF/, ''));
}

// `verify` needs the bytes, not just the parsed object: the result records the input's sha256.
function readManifestArgument(argument, stdin) {
  if (argument === '-') {
    const text = stdin != null ? String(stdin) : fs.readFileSync(0, 'utf8');
    return { kind: 'stdin', path: null, text, sha256: createHash('sha256').update(text).digest('hex') };
  }
  const target = path.resolve(argument);
  const bytes = fs.readFileSync(target);
  return { kind: 'file', path: target, text: bytes.toString('utf8').replace(/^\uFEFF/, ''), sha256: createHash('sha256').update(bytes).digest('hex') };
}

// `margin agent verify` is the one read-only, async verb. Every other branch stays synchronous so the
// existing `assert.equal(runAgentSourceCli(...), 0)` call sites keep working unchanged.
const VERIFY_HELP = [
  'Usage: margin agent verify <descriptor.json|-> [--path <home>] [--json] [--sample <n>]',
  '',
  'Read-only verification that a descriptor reads this machine through the same adapter the hosts',
  'consume and publishes at least one invariant-clean session.',
  '',
  '  --path <home>   explicit read path (still validated and probed)',
  '  --json          emit the versioned result document on stdout',
  '  --sample <n>    sessions whose invariants are checked (default 5, max 50)',
  '',
  'No writes anywhere. No network. No credential read. No Agent launch. The only subprocess spawned',
  'is `git rev-parse` as part of session workspace identity, inherited from the projection path.',
].join('\n');

async function runVerify(argv, { env, homedir, stdout, stderr, stdin }) {
  const usage = () => { write(stderr, 'Usage: margin agent verify <descriptor.json|-> [--path <home>] [--json] [--sample <n>]'); return 1; };
  if (argv.includes('--help') || argv.includes('-h')) { write(stdout, VERIFY_HELP); return 0; }
  const rest = argv.slice(1);
  let json = false;
  let sample = DEFAULT_SAMPLE;
  let explicitPath = null;
  let argument = null;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '--json') { json = true; continue; }
    if (token === '--path' || token === '--sample') {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('--')) return usage();
      index += 1;
      if (token === '--path') explicitPath = value;
      else sample = Number(value);
      continue;
    }
    if (token.startsWith('--path=')) { explicitPath = token.slice('--path='.length); continue; }
    if (token.startsWith('--sample=')) { sample = Number(token.slice('--sample='.length)); continue; }
    if (token.startsWith('--')) return usage();
    if (argument !== null) return usage();
    argument = token;
  }
  if (argument === null) return usage();
  if (!Number.isInteger(sample) || sample < 1 || sample > MAX_SAMPLE) {
    write(stderr, `Error: --sample must be an integer between 1 and ${MAX_SAMPLE}`);
    return 1;
  }

  let manifest;
  try { manifest = readManifestArgument(argument, stdin); }
  catch (error) { write(stderr, `Error: unable to read descriptor: ${error.message}`); return 1; }
  const input = { kind: manifest.kind, path: manifest.path, sha256: manifest.sha256 };

  let descriptor;
  try { descriptor = JSON.parse(manifest.text); }
  catch (error) {
    const result = verifyManifestError({ input, message: error.message });
    write(stdout, json ? JSON.stringify(result, null, 2) : formatVerifyResult(result));
    return verifyExitCode(result.verdict);
  }

  let result;
  try {
    result = await verifyAgentDescriptor({ descriptor, input, path: explicitPath, sample, env, ...(homedir ? { homedir } : {}) });
  } catch (error) { write(stderr, `Error: ${error.message}`); return 1; }
  write(stdout, json ? JSON.stringify(result, null, 2) : formatVerifyResult(result));
  return verifyExitCode(result.verdict);
}

export function runAgentSourceCli(argv, { env = process.env, homedir = undefined, stdout = process.stdout, stderr = process.stderr, stdin = null } = {}) {
  const options = { env, ...(homedir ? { homedir } : {}) };
  const loadRegistry = () => {
    const registry = readAgentSourceRegistry(options);
    if (registry?.ok === false) throw new Error(registry.error?.message ?? 'Unable to read agent source registry');
    return registry;
  };
  const command = argv[0];

  if (command === 'verify') return runVerify(argv, { env, homedir, stdout, stderr, stdin });

  if (command === 'list') {
    let registry; try { registry = loadRegistry(); } catch (error) { write(stderr, `Error: ${error.message}`); return 1; }
    if (!registry.sources.length) write(stdout, 'No agent sources registered. Run: margin agent detect');
    for (const source of registry.sources) write(stdout, formatSource(source, registry, options));
    // A registered Agent whose descriptor is broken is the case users cannot diagnose by looking at
    // the list, because the list only shows what loaded successfully.
    for (const problem of descriptorProblems(options)) {
      write(stdout, `problem\t${problem.type ?? '-'}\t${problem.code}\t${problem.source}\t${problem.errors.join('; ')}`);
    }
    return 0;
  }

  if (command === 'detect') {
    let result; try { result = detectAgentSources(loadRegistry(), options); writeAgentSourceRegistry(result.registry, options); } catch (error) { write(stderr, `Error: ${error.message}`); return 1; }
    if (!result.detected.length) write(stdout, 'No supported Agent sources found');
    else result.detected.forEach((source) => write(stdout, `Detected ${source.agentType}: ${source.home}${source.suppressed ? ' (removed: not re-added)' : ''}`));
    return 0;
  }

  if (command === 'add') {
    const type = argv[1]; const pathIndex = argv.indexOf('--path');
    const sourcePath = pathIndex >= 0 ? argv[pathIndex + 1] : defaultSourcePaths(options).find((candidate) => candidate.type === type)?.path;
    if (!type || !sourcePath) { write(stderr, 'Usage: margin agent add <type> [--path <home>]'); return 1; }
    try {
      const next = registerAgentSource(loadRegistry(), { type, path: sourcePath, origin: 'manual' }, options);
      const source = next.sources.at(-1); writeAgentSourceRegistry(next, options);
      write(stdout, `Registered ${source.agentType}: ${source.sourceId}`);
      return 0;
    } catch (error) { write(stderr, `Error: ${error.message}`); return 1; }
  }

  // Removal works for any origin now. An Agent detection would recreate is tombstoned instead of
  // deleted, because deleting it only moved the problem to the next detection pass.
  if (command === 'remove') {
    let current; try { current = loadRegistry(); } catch (error) { write(stderr, `Error: ${error.message}`); return 1; }
    const id = argv[1];
    const source = current.sources.find((item) => item.id === id);
    if (!source) { write(stderr, `Error: source not found: ${id}`); return 1; }
    const next = removeAgentSource(current, id, options);
    writeAgentSourceRegistry(next, options);
    const suppressed = next.sources.some((item) => item.id === id && item.suppressed === true);
    write(stdout, suppressed ? `Removed ${id} (removed: detection will not re-add it)` : `Removed ${id}`);
    return 0;
  }

  if (command === 'enable') {
    let current; try { current = loadRegistry(); } catch (error) { write(stderr, `Error: ${error.message}`); return 1; }
    const id = argv[1];
    if (!current.sources.some((item) => item.id === id)) { write(stderr, `Error: source not found: ${id}`); return 1; }
    writeAgentSourceRegistry(enableAgentSource(current, id, options), options);
    write(stdout, `Enabled ${id}`);
    return 0;
  }

  if (command === 'install') {
    const argument = argv.find((item) => !item.startsWith('--') && item !== 'install');
    if (!argument) { write(stderr, 'Usage: margin agent install <descriptor.json|-> [--path <home>] [--dry-run]'); return 1; }
    const pathIndex = argv.indexOf('--path');
    let descriptor;
    try { descriptor = readDescriptorArgument(argument, stdin); } catch (error) { write(stderr, `Error: unable to read descriptor: ${error.message}`); return 1; }
    let report;
    try {
      report = installAgentDescriptor({
        descriptor,
        path: pathIndex >= 0 ? argv[pathIndex + 1] : null,
        env, ...(homedir ? { homedir } : {}), dryRun: flag(argv, '--dry-run'),
      });
    } catch (error) { write(stderr, `Error: ${error.message}`); return 1; }
    if (!report.ok) { write(stderr, `Error: ${report.error.code}${report.error.errors ? `: ${report.error.errors.join('; ')}` : ''}`); return 1; }
    write(stdout, `${report.dryRun ? 'Would install' : 'Installed'} ${report.type} (${report.label}): descriptor ${report.descriptorChange} at ${report.descriptorPath}`);
    for (const candidate of report.candidates) {
      write(stdout, `  candidate\t${candidate.path}\t${candidate.exists ? 'exists' : 'missing'}\t${candidate.probe.valid ? 'probe ok' : candidate.probe.reason ?? 'probe failed'}`);
    }
    if (report.home) write(stdout, `  home\t${report.home.path}`);
    write(stdout, `  source\t${report.sourceChange}${report.sourceId ? ` (${report.sourceId})` : ''}`);
    for (const warning of report.warnings) write(stdout, `  warning\t${warning.code}\t${warning.message}`);
    return 0;
  }

  if (command === 'uninstall') {
    const type = argv[1];
    if (!type) { write(stderr, 'Usage: margin agent uninstall <type> [--dry-run]'); return 1; }
    let report;
    try { report = uninstallAgentDescriptor({ type, env, ...(homedir ? { homedir } : {}), dryRun: flag(argv, '--dry-run') }); }
    catch (error) { write(stderr, `Error: ${error.message}`); return 1; }
    if (!report.ok) { write(stderr, `Error: ${report.error.code}${report.error.message ? `: ${report.error.message}` : ''}`); return 1; }
    write(stdout, `${report.dryRun ? 'Would uninstall' : 'Uninstalled'} ${report.type}: descriptor ${report.descriptorChange}${report.descriptorPath ? ` at ${report.descriptorPath}` : ''}, ${report.purgedSources} source(s) purged`);
    return 0;
  }

  write(stderr, 'Usage: margin agent <list|detect|add|remove|enable|install|uninstall|verify>');
  return 1;
}

export { registryPath };
