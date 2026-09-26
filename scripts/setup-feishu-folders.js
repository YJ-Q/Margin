// One-time setup: creates Margin folder structure in Feishu Drive and saves tokens to job_tracker.sqlite
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createFeishuClient } from '../src/surfaces/feishu/feishuClient.js';
import { createJobStore } from '../src/surfaces/feishu/jobStore.js';

dotenv.config();

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = path.resolve(ROOT_DIR, 'data', 'job-tracker', 'job_tracker.sqlite');

const ROOT_FOLDER_TOKEN = process.env.FEISHU_ROOT_FOLDER_TOKEN;
if (!ROOT_FOLDER_TOKEN) {
  console.error('FEISHU_ROOT_FOLDER_TOKEN not set in .env');
  process.exit(1);
}

const client = createFeishuClient({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET
});

async function setup() {
  const store = await createJobStore({ dbPath: DB_PATH });

  await store.setFolder('root', ROOT_FOLDER_TOKEN);

  async function ensureFolder(parentToken, name, key) {
    const existing = await store.getFolder(key);
    if (existing) { console.log(`  (skip) ${name}: ${existing}`); return existing; }
    const res = await client.createFolder({ parentToken, name });
    const token = res?.data?.token;
    if (!token) throw new Error(`Failed to create folder "${name}": ${JSON.stringify(res)}`);
    await store.setFolder(key, token);
    console.log(`  ✓ ${name}: ${token}`);
    return token;
  }

  console.log('Creating folder structure under root:', ROOT_FOLDER_TOKEN);

  const marginToken = await ensureFolder(ROOT_FOLDER_TOKEN, 'Margin', 'margin');
  await ensureFolder(marginToken, '简历', 'resume');
  await ensureFolder(marginToken, '投递记录', 'applications');
  await ensureFolder(marginToken, '面试复盘', 'interviews');

  console.log('\nSetup complete. Add to .env:');
  console.log(`FEISHU_JOB_DB_PATH=data/job-tracker/job_tracker.sqlite`);

  await store.close();
}

setup().catch(err => { console.error(err.message); process.exit(1); });
