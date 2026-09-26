import { buildMorningBrief } from './morningBrief.js';

const COMMANDS = ['/brief', 'morning brief', '早报', '/status', '/help', 'help', '帮助', '/interview'];

export function createCommandHandler({ feishuClient, ownerOpenId, ensurePilot, getPilotStarted, getPilot, getInterviewHandler, getAgent }) {

  // 等待录音稿的会话状态：senderId → { company, role, round, expiresAt }
  const pendingInterview = new Map();

  async function handle(text, ctx) {
    const lower = text.toLowerCase().trim();
    const senderId = ctx.senderId || ownerOpenId;

    // 检查是否正在等待录音稿（通过 /interview 命令触发的流程）
    const pending = pendingInterview.get(senderId);
    if (pending) {
      if (Date.now() > pending.expiresAt) {
        pendingInterview.delete(senderId);
      } else if (lower !== '/cancel' && lower !== '取消') {
        pendingInterview.delete(senderId);
        return handleInterviewTranscript({ transcript: text, ...pending });
      } else {
        pendingInterview.delete(senderId);
        return '已取消面试复盘。';
      }
    }

    if (lower === '/brief' || lower === 'morning brief' || lower === '早报') {
      await buildMorningBrief({ feishuClient, receiveId: ctx.senderId || ownerOpenId });
      return null;
    }

    if (lower === '/status') return buildStatusCard({ getPilot, getPilotStarted });

    if (lower === '/help' || lower === 'help' || lower === '帮助') {
      return [
        '**Margin 指令**',
        '/brief — 生成今日早报',
        '/status — 查看 Agent 状态',
        '/interview [公司] [岗位] [轮次] — 开始面试复盘',
        '/help — 帮助',
        '',
        '直接发消息会转给 AI 处理。'
      ].join('\n');
    }

    // /interview [公司] [岗位] [轮次]
    if (lower.startsWith('/interview')) {
      const parts = text.trim().split(/\s+/);
      const company = parts[1] || '';
      const role = parts[2] || '';
      const round = parts[3] || '';

      if (!getInterviewHandler()) return '面试复盘功能未初始化，请检查配置。';

      // 登记等待状态，5分钟有效
      pendingInterview.set(senderId, {
        company, role, round,
        expiresAt: Date.now() + 5 * 60 * 1000
      });

      const hint = [company, role, round].filter(Boolean).join(' · ');
      return `好的${hint ? `，${hint}` : ''}，请发送面试录音稿，我来帮你整理复盘。\n\n（发送 /cancel 取消）`;
    }

    // 自动识别录音稿格式（无需先发指令）
    console.log('[commandHandler] checking transcript, len:', text.length, 'match:', isInterviewTranscript(text));
    if (isInterviewTranscript(text)) {
      return handleInterviewTranscript({ transcript: text, company: '', role: '', round: '' });
    }

    // Forward to Claude agent (or Pi fallback)
    const agent = getAgent?.();
    if (agent) {
      const result = await agent.handle(text);
      if (result.kind === 'error') return result.text || '处理出错，请重试。';
      return result.text || '（无响应）';
    }

    // Pi fallback (legacy)
    const p = await ensurePilot();
    if (!p || !getPilotStarted()) return 'AI 引擎未就绪，请稍后再试（检查配置）。';

    const result = await p.handle(text);
    if (result.kind === 'error') return result.text || '处理出错，请重试。';
    return result.text || '（无响应）';
  }

  async function handleInterviewTranscript({ transcript, company, role, round }) {
    if (!getInterviewHandler()) return '面试复盘功能正在初始化，请稍等 10 秒后重试。';
    try {
      const { url, docTitle, analysis } = await getInterviewHandler().handleTranscript({ transcript, company, role, round });
      const badCount = (analysis.questions || []).filter(q => q.score === 'bad' || q.score === 'ok').length;
      const goodCount = (analysis.questions || []).filter(q => q.score === 'good').length;
      const total = analysis.questions?.length || 0;

      // 返回 interactive card，包含文档链接按钮
      return {
        config: { wide_screen_mode: false },
        header: { title: { tag: 'plain_text', content: '面试复盘完成' }, template: 'green' },
        elements: [
          { tag: 'div', text: { tag: 'lark_md', content: `**${docTitle}**` } },
          { tag: 'div', text: { tag: 'lark_md', content: analysis.overall_assessment || '' } },
          { tag: 'hr' },
          { tag: 'div', text: { tag: 'lark_md', content: `📊 共 ${total} 题 · ${badCount} 题待改进 · ${goodCount} 题不错` } },
          {
            tag: 'action',
            actions: [{
              tag: 'button',
              text: { tag: 'plain_text', content: '查看复盘文档' },
              type: 'primary',
              url
            }]
          }
        ]
      };
    } catch (err) {
      console.error('[interview] error:', err.message);
      return `复盘处理出错：${err.message}`;
    }
  }

  function isInstantReply(text) {
    const lower = text.toLowerCase().trim();
    return COMMANDS.includes(lower) || lower.startsWith('/interview');
  }

  return { handle, isInstantReply };
}

// 识别录音转写稿的特征：包含【面试官】或"面试官："或"interviewer:"等模式
function isInterviewTranscript(text) {
  if (text.length < 100) return false;
  return /【面试官】|面试官[：:]\s*|interviewer[：:]\s*|\[面试官\]/i.test(text);
}

async function buildStatusCard({ getPilot, getPilotStarted }) {
  const elements = [];

  const pilot = getPilot();
  const piReady = pilot && getPilotStarted();
  elements.push({ tag: 'div', text: { tag: 'lark_md', content: piReady ? '🟢 **Pi AI 已连接**' : '🔴 **Pi AI 未就绪**' } });

  if (piReady) {
    try {
      const state = await pilot.getState?.();
      if (state) {
        elements.push({ tag: 'div', text: { tag: 'lark_md', content: `工作流：**${state.title ?? '未知'}** \`${state.status}\`` } });
        if (state.nextAction) elements.push({ tag: 'div', text: { tag: 'lark_md', content: `→ ${state.nextAction}` } });
      }
    } catch {}
  }

  elements.push({ tag: 'hr' });
  elements.push({ tag: 'div', text: { tag: 'lark_md', content: `✅ Feishu Surface 运行中\n🕐 ${now}` } });

  return { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: 'Margin 状态' }, template: 'blue' }, elements };
}
