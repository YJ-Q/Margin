import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMarginSurface } from '../src/core/handoff/createMarginSurface.js';
import { createRunBindingReader } from '../src/core/handoff/createRunBindingReader.js';

export async function main({
  argv = process.argv.slice(2), env = process.env,
  stdout = process.stdout, stderr = process.stderr, signalSource = process
} = {}) {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dev = argv.includes('--dev');
  let surface;
  let bindingReader;
  let shutdownPromise;
  const shutdown = () => {
    shutdownPromise ??= (async () => {
      try { await surface?.close?.(); } finally { await bindingReader?.close?.(); }
    })();
    return shutdownPromise;
  };
  const onSignal = () => {
    signalSource.off?.('SIGINT', onSignal);
    signalSource.off?.('SIGTERM', onSignal);
    shutdown().catch(() => { process.exitCode = 1; });
  };
  try {
    bindingReader = await createRunBindingReader({ rootDir, env }).catch(() => null);
    surface = await createMarginSurface({ rootDir, dev, env, resolveRuns: bindingReader?.resolveRuns ?? null });
    const started = await surface.start();
    signalSource.once?.('SIGINT', onSignal);
    signalSource.once?.('SIGTERM', onSignal);
    stdout.write(`margin_surface_ready ${started.origin}\n`);
    return 0;
  } catch (error) {
    await shutdown().catch(() => {});
    const code = error?.message?.startsWith('margin_surface_assets_missing') ? error.message : (error?.code ?? 'margin_surface_start_failed');
    stderr.write(`${code}\n`);
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main();
