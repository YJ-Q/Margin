import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const disposition = () => 'archive';

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function inventoryLegacyData({ dbPath }) {
  if (!dbPath) throw new TypeError('legacy_db_path_required');
  const db = await open({ filename: dbPath, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
  try {
    const tableRows = await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    const tables = [];
    for (const { name } of tableRows) {
      const columns = (await db.all(`PRAGMA table_info(${JSON.stringify(name)})`)).map(({ name: columnName, type, notnull, pk }) => ({ name: columnName, type, required: Boolean(notnull), primaryKey: Boolean(pk) }));
      const { count } = await db.get(`SELECT COUNT(*) count FROM ${JSON.stringify(name)}`);
      tables.push({
        name, rowCount: count, columns,
        schemaHash: createHash('sha256').update(JSON.stringify(columns)).digest('hex'),
        disposition: disposition(name)
      });
    }
    return {
      databaseKind: 'legacy_echo', dbPath: path.resolve(dbPath), fileHash: await hashFile(dbPath),
      schemaHash: createHash('sha256').update(JSON.stringify(tables.map(({ name, columns }) => ({ name, columns })))).digest('hex'),
      tables,
      policy: 'read_only_inventory_no_automatic_import'
    };
  } finally { await db.close(); }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dbPath = process.argv[2] ?? path.resolve('data', 'echo.sqlite');
  process.stdout.write(`${JSON.stringify(await inventoryLegacyData({ dbPath }), null, 2)}\n`);
}
