import { verifyFeishuSignature } from './feishuClient.js';

const CHALLENGE_TYPE = 'url_verification';
const MESSAGE_EVENT = 'im.message.receive_v1';

export function createFeishuWebhookHandler({ feishuClient, onMessage, encryptKey = '' }) {
  if (!feishuClient || typeof onMessage !== 'function') {
    throw new TypeError('feishu_handler_missing_dependencies');
  }

  const processed = new Map();

  function isDuplicate(eventId) {
    if (!eventId) return false;
    if (processed.has(eventId)) return true;
    processed.set(eventId, Date.now());
    if (processed.size > 1000) {
      const cutoff = Date.now() - 10 * 60 * 1000;
      for (const [id, ts] of processed) {
        if (ts < cutoff) processed.delete(id);
      }
    }
    return false;
  }

  async function handle(rawBody, headers = {}) {
    let payload;
    try {
      payload = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
    } catch {
      return { status: 400, body: { code: 'invalid_json' } };
    }

    if (encryptKey && headers['x-lark-signature']) {
      const timestamp = headers['x-lark-request-timestamp'] || '';
      const nonce = headers['x-lark-request-nonce'] || '';
      const expected = verifyFeishuSignature({ timestamp, nonce, body: typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody), secret: encryptKey });
      if (expected !== headers['x-lark-signature']) {
        return { status: 401, body: { code: 'invalid_signature' } };
      }
    }

    if (payload.type === CHALLENGE_TYPE) {
      return { status: 200, body: { challenge: payload.challenge } };
    }

    const header = payload.header ?? {};
    const eventId = header.event_id;

    if (isDuplicate(eventId)) {
      return { status: 200, body: { code: 'duplicate' } };
    }

    const eventType = header.event_type;
    console.log(`[webhook] event_id=${eventId} type=${eventType}`);
    if (eventType === MESSAGE_EVENT) {
      const event = payload.event ?? {};
      const msg = event.message ?? {};
      const sender = event.sender ?? {};
      const messageContext = {
        eventId,
        messageId: msg.message_id,
        chatId: msg.chat_id,
        chatType: msg.chat_type,
        senderId: sender.sender_id?.open_id,
        senderType: sender.sender_type,
        msgType: msg.message_type,
        content: safeParseContent(msg.content, msg.message_type),
        rawContent: msg.content,
        createdAt: msg.create_time ? new Date(Number(msg.create_time)).toISOString() : new Date().toISOString()
      };

      try {
        console.log(`[webhook] msg id=${messageContext.messageId} type=${messageContext.msgType} chat_type=${messageContext.chatType} sender=${messageContext.senderId}`);
        console.log(`[webhook] raw_content=${msg.content}`);
        console.log(`[webhook] parsed_content="${String(messageContext.content).slice(0,200)}"`);
        await onMessage(messageContext, feishuClient);
      } catch (err) {
        console.error('[feishu] onMessage error', err?.message);
      }
    }

    return { status: 200, body: {} };
  }

  return Object.freeze({ handle });
}

function safeParseContent(raw, msgType) {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (msgType === 'text') return parsed.text ?? '';
    return parsed;
  } catch {
    return raw;
  }
}
