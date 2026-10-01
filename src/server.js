import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The Echo database and product API are archived. Keep the historical modules
// for review, but never start a listener that can mutate the frozen dataset.
export async function main({ stderr = process.stderr } = {}) {
  stderr.write('legacy_api_archived: the Echo API can no longer be started\n');
  return 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main();
