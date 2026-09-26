// Persistent status dashboard: sends one card to the monitor group on startup,
// then patches it in-place on a fixed interval and on key events.

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export function createMonitor({ feishuClient, chatId, getPilotState }) {
  if (!chatId) return { start() {}, notify() {} };

  let dashboardMessageId = null;
  let timer = null;

  function formatUptime(startedAt) {
    const ms = Date.now() - startedAt;
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  async function buildCard(state) {
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const elements = [];

    // Agent status row
    const online = state.pilotReady;
    elements.push({
      tag: 'column_set',
      flex_mode: 'none',
      background_style: 'default',
      columns: [
        {
          tag: 'column', width: 'weighted', weight: 1,
          elements: [{ tag: 'div', text: { tag: 'lark_md', content: online ? '🟢 **在线**' : '🔴 **离线**' } }]
        },
        {
          tag: 'column', width: 'weighted', weight: 3,
          elements: [{ tag: 'div', text: { tag: 'lark_md', content: `Pi AI ${online ? '已连接' : '未就绪'}` } }]
        }
      ]
    });

    elements.push({ tag: 'hr' });

    // Run status
    if (state.runStatus) {
      const statusEmoji = { running: '▶️', paused: '⏸️', queued: '⏳', needs_owner: '⚠️' }[state.runStatus] ?? '❓';
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: `${statusEmoji} Run 状态：\`${state.runStatus}\`` } });
    }

    // Current task
    if (state.currentTask) {
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: `📌 当前任务：${state.currentTask}` } });
    }

    // Last activity
    if (state.lastActivityAt) {
      const lastActive = new Date(state.lastActivityAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: `🕐 最后活跃：${lastActive}` } });
    }

    // Message count
    if (state.messageCount != null && state.messageCount > 0) {
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: `💬 累计消息：${state.messageCount} 条` } });
    }

    elements.push({ tag: 'hr' });
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `🔄 更新于 ${now}` } });

    return {
      config: { wide_screen_mode: false },
      header: {
        title: { tag: 'plain_text', content: 'Margin 状态监控' },
        template: online ? 'blue' : 'grey'
      },
      elements
    };
  }

  async function refresh() {
    try {
      const state = await getPilotState();
      const card = await buildCard(state);

      if (!dashboardMessageId) {
        // First time: send the card and pin it
        const res = await feishuClient.sendMessage({
          receiveId: chatId,
          receiveIdType: 'chat_id',
          msgType: 'interactive',
          content: card
        });
        dashboardMessageId = res?.data?.message_id;
        if (dashboardMessageId) {
          console.log('[monitor] dashboard card sent:', dashboardMessageId);
          // Pin the message
          await feishuClient.pinMessage({ messageId: dashboardMessageId }).catch(() => {});
        }
      } else {
        // Subsequent: patch the existing card
        await feishuClient.patchMessage({ messageId: dashboardMessageId, content: card });
      }
    } catch (err) {
      console.error('[monitor] refresh error:', err?.message);
    }
  }

  async function notify(event) {
    const { type, text } = event;
    const emoji = { error: '🚨', task_done: '✅', task_start: '🚀', warning: '⚠️' }[type] ?? 'ℹ️';
    try {
      await feishuClient.sendMessage({
        receiveId: chatId,
        receiveIdType: 'chat_id',
        msgType: 'text',
        content: JSON.stringify({ text: `${emoji} ${text}` })
      });
    } catch (err) {
      console.error('[monitor] notify error:', err?.message);
    }
  }

  async function start() {
    await refresh();
    timer = setInterval(refresh, REFRESH_INTERVAL_MS);
  }

  function stop() {
    if (timer) clearInterval(timer);
  }

  return { start, stop, refresh, notify };
}
