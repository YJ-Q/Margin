import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function main({ env = process.env, stderr = process.stderr } = {}) {
  stderr.write('[archived] The legacy Echo API is no longer available. The Margin Board is started with npm start.\n');
  const legacy = await import('../src/server.js');
  return legacy.main({ env, stderr });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main();
