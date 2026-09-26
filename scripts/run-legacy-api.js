import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function main({ env = process.env, stderr = process.stderr } = {}) {
  stderr.write('[deprecated] The legacy Margin API is isolated. The current default surface is the Margin Board (npm start); the Application Contract is served by npm run legacy:workbench.\n');
  env.MARGIN_ENABLE_LEGACY_API = 'true';
  const legacy = await import('../src/server.js');
  return legacy.main({ env });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main();
