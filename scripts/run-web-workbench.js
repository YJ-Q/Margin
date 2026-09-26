import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createWebWorkbench } from '../src/web/createWebWorkbench.js';

dotenv.config();

export async function main({
  argv = process.argv.slice(2), env = process.env,
  stdout = process.stdout, stderr = process.stderr, signalSource = process
} = {}) {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dev = argv.includes('--dev');
  let workbench;
  let shutdownPromise;
  const shutdown = () => {
    shutdownPromise ??= workbench?.close?.() ?? Promise.resolve();
    return shutdownPromise;
  };
  const onSignal = () => {
    signalSource.off?.('SIGINT', onSignal);
    signalSource.off?.('SIGTERM', onSignal);
    shutdown().catch(() => { process.exitCode = 1; });
  };
  try {
    workbench = await createWebWorkbench({ rootDir, dev, env });
    const started = await workbench.start();
    signalSource.once?.('SIGINT', onSignal);
    signalSource.once?.('SIGTERM', onSignal);
    // The Workbench UI was removed with the surface consolidation (ADR 003); this now serves the
    // Application Contract's HTTP API. Say so, so nobody waits for a page that will never appear.
    stdout.write(`margin_contract_api_ready ${started.origin} (api only; the legacy Workbench UI was removed)\n`);
    return 0;
  } catch (error) {
    await shutdown().catch(() => {});
    stderr.write(`${error?.code ?? 'web_start_failed'}: ${error?.message ?? ''}\n`);
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main();
