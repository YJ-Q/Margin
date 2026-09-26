import { writeFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

/**
 * Claude tools for reading/writing the resume bitable in Feishu.
 *
 * Env vars required:
 *   FEISHU_RESUME_APP_TOKEN  — the Bitable app token (from the URL: /base/<token>)
 *   FEISHU_RESUME_TABLE_ID   — the table ID inside that app
 *
 * Table schema (columns):
 *   标题       text      short description of the experience
 *   类型       select    工作经历 / 项目 / 技能 / 教育 / 自我介绍
 *   公司或项目  text
 *   时间       text      e.g. "2023.03 - 2024.06"
 *   技术栈     multiselect
 *   详细描述   text      STAR format
 *   适用岗位   multiselect  e.g. 后端 / 全栈 / AI
 */

function extractTextValue(cell) {
  if (!cell) return '';
  if (typeof cell === 'string') return cell;
  if (Array.isArray(cell)) return cell.map(v => v?.text ?? v).join(', ');
  if (typeof cell === 'object' && cell.text) return cell.text;
  return String(cell);
}

function recordToEntry(record) {
  const f = record.fields ?? {};
  return {
    id: record.record_id,
    title: extractTextValue(f['标题']),
    type: extractTextValue(f['类型']),
    company: extractTextValue(f['公司或项目']),
    period: extractTextValue(f['时间']),
    stack: extractTextValue(f['技术栈']),
    description: extractTextValue(f['详细描述']),
    roles: extractTextValue(f['适用岗位'])
  };
}

async function fetchAllRecords(feishuClient, appToken, tableId) {
  const entries = [];
  let pageToken;
  do {
    const res = await feishuClient.listBitableRecords({ appToken, tableId, pageSize: 100, pageToken });
    if (res.code !== 0) throw new Error(`bitable_error: ${res.msg}`);
    for (const r of res.data?.items ?? []) entries.push(recordToEntry(r));
    pageToken = res.data?.has_more ? res.data.page_token : null;
  } while (pageToken);
  return entries;
}

export function createResumeBitableTools({ feishuClient, dataDir }) {
  const appToken = process.env.FEISHU_RESUME_APP_TOKEN;
  const tableId = process.env.FEISHU_RESUME_TABLE_ID;

  const tools = [
    {
      name: 'resume_list_entries',
      label: '列出简历条目',
      description: '从飞书多维表格读取所有简历经历条目，可按类型或适用岗位筛选。',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', description: '筛选类型，如"工作经历"、"项目"、"技能"，不传则返回全部' },
          role: { type: 'string', description: '筛选适用岗位，如"后端"、"AI"，不传则返回全部' }
        },
        required: []
      },
      handler: async ({ type, role } = {}) => {
        if (!appToken || !tableId) return { ok: false, error: { code: 'resume_bitable_not_configured' } };
        const entries = await fetchAllRecords(feishuClient, appToken, tableId);
        let filtered = entries;
        if (type) filtered = filtered.filter(e => e.type.includes(type));
        if (role) filtered = filtered.filter(e => e.roles.includes(role));
        return { ok: true, data: { entries: filtered, total: filtered.length } };
      }
    },
    {
      name: 'resume_add_entry',
      label: '新增简历条目',
      description: '向飞书多维表格新增一条经历或资料。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          type: { type: 'string', enum: ['工作经历', '项目', '技能', '教育', '自我介绍'] },
          company: { type: 'string' },
          period: { type: 'string' },
          stack: { type: 'string' },
          description: { type: 'string' },
          roles: { type: 'string', description: '适用岗位，逗号分隔' }
        },
        required: ['title', 'type', 'description']
      },
      handler: async ({ title, type, company, period, stack, description, roles } = {}) => {
        if (!appToken || !tableId) return { ok: false, error: { code: 'resume_bitable_not_configured' } };
        const fields = {
          '标题': title,
          '类型': type,
          '详细描述': description,
          ...(company ? { '公司或项目': company } : {}),
          ...(period ? { '时间': period } : {}),
          ...(stack ? { '技术栈': stack } : {}),
          ...(roles ? { '适用岗位': roles } : {})
        };
        const res = await feishuClient.createBitableRecord({ appToken, tableId, fields });
        if (res.code !== 0) return { ok: false, error: { code: 'bitable_error', message: res.msg } };
        return { ok: true, data: { recordId: res.data?.record?.record_id } };
      }
    },
    {
      name: 'resume_generate_yaml',
      label: '生成简历 YAML',
      description: '从飞书资料库按岗位筛选条目，生成 resume.yaml 文件并保存到本地，供 findjobs 使用。',
      parameters: {
        type: 'object',
        properties: {
          role: { type: 'string', description: '目标岗位，如"后端"、"全栈"、"AI"' },
          name: { type: 'string', description: '简历文件名，默认 resume.yaml' }
        },
        required: ['role']
      },
      handler: async ({ role, name = 'resume.yaml' } = {}) => {
        if (!appToken || !tableId) return { ok: false, error: { code: 'resume_bitable_not_configured' } };
        const entries = await fetchAllRecords(feishuClient, appToken, tableId);
        const forRole = entries.filter(e => !e.roles || e.roles.includes(role) || e.roles.includes('通用'));

        const grouped = { work: [], projects: [], skills: [], education: [], intro: [] };
        for (const e of forRole) {
          if (e.type.includes('工作')) grouped.work.push(e);
          else if (e.type.includes('项目')) grouped.projects.push(e);
          else if (e.type.includes('技能')) grouped.skills.push(e);
          else if (e.type.includes('教育')) grouped.education.push(e);
          else if (e.type.includes('自我介绍')) grouped.intro.push(e);
        }

        const doc = {
          target_role: role,
          summary: grouped.intro[0]?.description ?? '',
          work_experience: grouped.work.map(e => ({
            company: e.company,
            period: e.period,
            title: e.title,
            description: e.description,
            stack: e.stack
          })),
          projects: grouped.projects.map(e => ({
            name: e.title,
            period: e.period,
            description: e.description,
            stack: e.stack
          })),
          skills: grouped.skills.map(e => e.description).join('\n'),
          education: grouped.education.map(e => ({
            school: e.company,
            period: e.period,
            description: e.description
          }))
        };

        const outPath = path.resolve(dataDir ?? 'data', 'resume', name);
        await mkdir(path.dirname(outPath), { recursive: true });
        await writeFile(outPath, yaml.dump(doc, { allowUnicode: true }), 'utf8');
        return { ok: true, data: { path: outPath, entriesUsed: forRole.length } };
      }
    }
  ];

  return tools;
}
