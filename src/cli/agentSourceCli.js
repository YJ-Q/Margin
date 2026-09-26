import fs from 'node:fs';
import { readAgentSourceRegistry, writeAgentSourceRegistry, detectAgentSources, registerAgentSource, removeAgentSource, enableAgentSource, validateSource, registryPath, defaultSourcePaths, descriptorProblems } from '../agents/sourceRegistry.js';
import { resolveActiveSource } from '../agents/sourceRegistry.js';
import { installAgentDescriptor, uninstallAgentDescriptor } from '../agents/agentInstall.js';

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

export function runAgentSourceCli(argv, { env = process.env, homedir = undefined, stdout = process.stdout, stderr = process.stderr, stdin = null } = {}) {
  const options = { env, ...(homedir ? { homedir } : {}) };
  const loadRegistry = () => {
    const registry = readAgentSourceRegistry(options);
    if (registry?.ok === false) throw new Error(registry.error?.message ?? 'Unable to read agent source registry');
    return registry;
  };
  const command = argv[0];

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

  write(stderr, 'Usage: margin agent <list|detect|add|remove|enable|install|uninstall>');
  return 1;
}

export { registryPath };
