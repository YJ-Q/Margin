#!/usr/bin/env node
// Margin CLI V1 entry — wires the real handoff Core into the interactive runner.
// npm link / package install exposes this as the `margin` command.
import { discoverSessions, captureSession, generateHandoff } from '../src/core/handoff/index.js';
import { createPrompter, runMarginCli } from '../src/cli/margin/index.js';
import { runAgentSourceCli } from '../src/cli/agentSourceCli.js';
import { runRunBridgeCli } from '../src/cli/runBridgeCli.js';
import { runCostCli } from '../src/cli/margin/runCostCli.js';
import { adapterFor } from '../src/agents/adapters.js';

if (process.argv[2] === 'agent') {
  process.exitCode = runAgentSourceCli(process.argv.slice(3));
} else if (process.argv[2] === 'run') {
  process.exitCode = await runRunBridgeCli(process.argv.slice(3));
} else if (process.argv[2] === 'cost') {
  process.exitCode = runCostCli(process.argv.slice(3));
} else {
  const prompter = createPrompter({ input: process.stdin, output: process.stdout });

  const exitCode = await runMarginCli({
    discoverSessions: async () => {
      const { readAgentSourceRegistry, writeAgentSourceRegistry, detectAgentSources, resolveActiveSource } = await import('../src/agents/sourceRegistry.js');
      const registry = readAgentSourceRegistry();
      // A corrupt/unreadable registry is not a blank first-run registry.  Do not let the CLI
      // convenience detector replace it with an auto-generated empty/default file.
      if (registry?.ok === false) throw new Error(registry.error?.message ?? 'Unable to read agent source registry');
      const detected = detectAgentSources(registry);
      try { writeAgentSourceRegistry(detected.registry); } catch {}
      const source = resolveActiveSource(detected.registry, 'codex');
      return source ? adapterFor('codex').discoverSessions(source, { env: process.env }) : [];
    },
    captureSession,
    generateHandoff,
    prompt: (text) => prompter.ask(text),
    stdout: process.stdout,
    stderr: process.stderr,
  });

  prompter.close();
  process.exitCode = exitCode;
}
