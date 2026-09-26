import { Type } from 'typebox';

// Returns an array of extraTools definitions to pass to createPiTerminalPilotRuntime
export function createJobTools({ interviewHandler, jobStore }) {
  const tools = [];

  if (interviewHandler) {
    tools.push({
      name: 'interview_analyze',
      label: 'Interview Review',
      description: '分析面试录音转写稿，生成结构化复盘文档并写入飞书。用户发送面试对话文本时调用。输入 transcript 为完整对话内容，company/role/round 可选（从稿子自动推断）。',
      parameters: Type.Object({
        transcript: Type.String({ description: '面试对话全文，"面试官：xxx / 我：xxx" 格式' }),
        company: Type.Optional(Type.String({ description: '公司名' })),
        role: Type.Optional(Type.String({ description: '岗位名' })),
        round: Type.Optional(Type.String({ description: '面试轮次，如一面/二面/终面' }))
      }, { additionalProperties: false }),
      handler: async (input) => {
        try {
          const result = await interviewHandler.handleTranscript({
            transcript: input.transcript,
            company: input.company || '',
            role: input.role || '',
            round: input.round || ''
          });
          return {
            ok: true,
            data: {
              message: `复盘完成：${result.docTitle}\n\n${result.analysis.overall_assessment || ''}\n\n📊 共 ${result.analysis.questions?.length || 0} 题：待改进 ${(result.analysis.questions || []).filter(q => q.score !== 'good').length} 题\n\n📄 文档：${result.url}`,
              documentId: result.documentId,
              url: result.url,
              docTitle: result.docTitle
            }
          };
        } catch (err) {
          return { ok: false, error: { code: 'interview_analyze_failed', message: err.message } };
        }
      }
    });
  }

  if (jobStore) {
    tools.push({
      name: 'job_add',
      label: 'Add Job Application',
      description: '记录一条求职投递信息到本地数据库。用户说"我投了/我要投某公司某岗位"时调用。',
      parameters: Type.Object({
        company: Type.String({ description: '公司名' }),
        role: Type.String({ description: '岗位名' }),
        status: Type.Optional(Type.Union([
          Type.Literal('planned'), Type.Literal('applied'),
          Type.Literal('interview'), Type.Literal('offer'), Type.Literal('rejected')
        ], { description: '投递状态，默认 applied' })),
        jdUrl: Type.Optional(Type.String({ description: 'JD 链接' })),
        notes: Type.Optional(Type.String({ description: '备注' }))
      }, { additionalProperties: false }),
      handler: async (input) => {
        try {
          const app = await jobStore.addApplication({
            company: input.company,
            role: input.role,
            status: input.status || 'applied',
            jdUrl: input.jdUrl || '',
            notes: input.notes || ''
          });
          return { ok: true, data: { message: `✅ 已记录：${input.company} · ${input.role}（${app.status}）`, id: app.id } };
        } catch (err) {
          return { ok: false, error: { code: 'job_add_failed', message: err.message } };
        }
      }
    });

    tools.push({
      name: 'job_list',
      label: 'List Job Applications',
      description: '查询投递记录列表。用户问"我投了哪些公司""进展怎么样"时调用。',
      parameters: Type.Object({
        statuses: Type.Optional(Type.Array(Type.String(), { description: '按状态筛选，如 ["applied","interview"]，不传则返回全部' }))
      }, { additionalProperties: false }),
      handler: async (input) => {
        try {
          const apps = await jobStore.listApplications({ statuses: input.statuses });
          if (apps.length === 0) return { ok: true, data: { message: '暂无投递记录。' } };
          const statusLabel = { planned: '待投递', applied: '已投递', interview: '面试中', offer: 'Offer', rejected: '已淘汰' };
          const lines = apps.map(a => `• **${a.company}** · ${a.role} — ${statusLabel[a.status] ?? a.status}（${a.applied_at.slice(0, 10)}）`);
          return { ok: true, data: { message: `**投递记录（${apps.length} 条）**\n\n${lines.join('\n')}` } };
        } catch (err) {
          return { ok: false, error: { code: 'job_list_failed', message: err.message } };
        }
      }
    });

    tools.push({
      name: 'job_update',
      label: 'Update Job Application',
      description: '更新投递状态或备注。用户说"字节给我发了二面通知""被拒了"等时调用。',
      parameters: Type.Object({
        company: Type.String({ description: '公司名' }),
        role: Type.Optional(Type.String({ description: '岗位名，有多个投递时用于精确匹配' })),
        status: Type.Optional(Type.Union([
          Type.Literal('planned'), Type.Literal('applied'),
          Type.Literal('interview'), Type.Literal('offer'), Type.Literal('rejected')
        ])),
        notes: Type.Optional(Type.String())
      }, { additionalProperties: false }),
      handler: async (input) => {
        try {
          const app = await jobStore.findApplication({ company: input.company, role: input.role });
          if (!app) return { ok: false, error: { code: 'job_not_found', message: `未找到 ${input.company} 的投递记录` } };
          const updates = {};
          if (input.status) updates.status = input.status;
          if (input.notes) updates.notes = input.notes;
          await jobStore.updateApplication(app.id, updates);
          const statusLabel = { planned: '待投递', applied: '已投递', interview: '面试中', offer: 'Offer', rejected: '已淘汰' };
          return { ok: true, data: { message: `✅ 已更新：${app.company} · ${app.role} → ${statusLabel[input.status] ?? input.status}` } };
        } catch (err) {
          return { ok: false, error: { code: 'job_update_failed', message: err.message } };
        }
      }
    });
  }

  return tools;
}
