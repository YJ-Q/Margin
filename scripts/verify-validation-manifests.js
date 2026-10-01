import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function artifactPath(rootDir, relativePath) {
  const validationRoot = path.join(rootDir, 'docs', 'validation');
  const resolved = path.resolve(rootDir, relativePath);
  if (!resolved.startsWith(`${validationRoot}${path.sep}`)) throw new Error(`manifest_path_outside_validation: ${relativePath}`);
  return resolved;
}

export async function verifyValidationManifests({ rootDir = repositoryRoot, fix = false } = {}) {
  const validationRoot = path.join(rootDir, 'docs', 'validation');
  const directories = await readdir(validationRoot, { withFileTypes: true });
  const mismatches = [];
  let checked = 0;
  let repaired = 0;

  for (const directory of directories.filter((entry) => entry.isDirectory())) {
    const manifestPath = path.join(validationRoot, directory.name, 'manifest.json');
    let manifest;
    try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); }
    catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    let dirty = false;
    const entries = [
      ...(manifest.artifacts ?? []).map((entry) => ({ entry, file: entry.path, hashKey: 'sha256', bytesKey: null })),
      ...(manifest.cases ?? []).filter((entry) => entry.handoff && entry.handoffSha256)
        .map((entry) => ({ entry, file: entry.handoff, hashKey: 'handoffSha256', bytesKey: 'handoffBytes' })),
    ];

    for (const { entry, file, hashKey, bytesKey } of entries) {
      const contents = await readFile(artifactPath(rootDir, file));
      const actualHash = createHash('sha256').update(contents).digest('hex');
      const recordedHash = String(entry[hashKey]).toLowerCase();
      const actualBytes = contents.length;
      checked += 1;
      const errors = [];
      if (recordedHash !== actualHash) errors.push('sha256');
      if (bytesKey && entry[bytesKey] !== actualBytes) errors.push('bytes');
      if (bytesKey && typeof entry.sourceBytes === 'number' && entry.reductionPct !== 100 * (1 - actualBytes / entry.sourceBytes)) errors.push('reductionPct');
      if (!errors.length) continue;
      if (!fix) { mismatches.push({ file, fields: errors }); continue; }
      entry[hashKey] = entry[hashKey] === entry[hashKey].toUpperCase() ? actualHash.toUpperCase() : actualHash;
      if (bytesKey) entry[bytesKey] = actualBytes;
      if (bytesKey && typeof entry.sourceBytes === 'number') entry.reductionPct = 100 * (1 - actualBytes / entry.sourceBytes);
      dirty = true;
      repaired += 1;
    }
    if (dirty) await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  return { checked, repaired, mismatches };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = await verifyValidationManifests({ fix: process.argv.includes('--fix') });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.mismatches.length) process.exitCode = 1;
}
