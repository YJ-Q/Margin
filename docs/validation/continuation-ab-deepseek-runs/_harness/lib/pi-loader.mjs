// Loads the global pi-coding-agent build (same one the pi CLI runs, 0.85.1),
// so harness behavior matches the production runtime used by the controller.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadPi() {
  const npmRoot = process.env.PI_GLOBAL_NPM_ROOT;
  if (!npmRoot) throw new Error('PI_GLOBAL_NPM_ROOT is not set');
  const piDir = path.join(npmRoot, '@earendil-works', 'pi-coding-agent');
  const mod = await import(pathToFileURL(path.join(piDir, 'dist', 'index.js')).href);
  return mod;
}

export function piDir() {
  const npmRoot = process.env.PI_GLOBAL_NPM_ROOT;
  if (!npmRoot) throw new Error('PI_GLOBAL_NPM_ROOT is not set');
  return path.join(npmRoot, '@earendil-works', 'pi-coding-agent');
}
