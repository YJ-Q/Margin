// Transcript-derived execution status for the Claude Code and Pi built-in readers.
//
// Both Agents are built-in session readers (Claude's multi-file project layout plus archive state,
// Pi's two-level session directories), so they cannot use the descriptor `transcript` status
// extractor the way a simple file-per-session plugin does. They obey the extractor's one semantic
// rule nevertheless: classify the LAST assistant turn the transcript contains.
//
//   * the last assistant turn carries the Agent's native error marker -> 'error'
//   * the last assistant turn ended requesting a tool                 -> 'working'
//     (its tool result has not become the new end of the transcript)
//   * the last assistant turn produced an answer                      -> 'idle'
//   * no interpretable assistant turn                                  -> 'unknown'
//
// Status is read from the records discovery already parsed — no file is opened a second time — and
// is never inferred from free text. A tool result reporting a command failure is not an Agent
// error: the turn continues normally, which is why only native terminal/turn markers count here.

const nonEmptyText = (value) => typeof value === 'string' && value.trim().length > 0;

function contentParts(message) {
  return Array.isArray(message?.content) ? message.content : [];
}

// Claude Code (VS Code / CLI) transcript shape:
//   { type: 'assistant', isApiErrorMessage?: true, message: { role: 'assistant',
//     stop_reason: 'tool_use' | 'end_turn' | 'stop_sequence', content: [ {type:'tool_use'|'text'} ] } }
// Observed over 3,895 assistant records on this machine: 3,534 tool_use, 318 end_turn,
// 25 stop_sequence, 18 without the field; 25 records carry isApiErrorMessage.
export function readClaudeExecutionStatus(records) {
  const turns = [];
  for (const record of records ?? []) {
    if (record?.type !== 'assistant' || record?.message?.role !== 'assistant') continue;
    // Sidechain/subagent turns belong to their own controller session; discovery excludes those
    // files outright, but the guard stays local so the reader is safe on any transcript.
    if (record.isSidechain === true || record.sidechain === true) continue;
    const message = record.message;
    const parts = contentParts(message);
    const hasToolUse = parts.some((part) => part?.type === 'tool_use');
    const hasText = parts.some((part) => part?.type === 'text' && nonEmptyText(part.text))
      || nonEmptyText(message.content);
    const stopReason = message.stop_reason ?? message.stopReason ?? null;
    turns.push({
      error: record.isApiErrorMessage === true,
      // stop_reason 'tool_use' is the streamed "waiting on the tool result" marker. A few older
      // historical records omit the field entirely; the tool_use block is the same signal.
      waitingOnTool: stopReason === 'tool_use' || (stopReason === null && hasToolUse),
      hasText,
    });
  }
  if (!turns.length) return 'unknown';
  const last = turns[turns.length - 1];
  if (last.error) return 'error';
  if (last.waitingOnTool) return 'working';
  if (last.hasText) return 'idle';
  return 'unknown';
}

// Pi transcript shape:
//   { type: 'message', message: { role: 'assistant', stopReason: 'toolUse' | 'stop' | 'error' |
//     'aborted', content: [ {type:'toolCall'|'text'} ] } }
// Observed over 34 sessions / 4,551 assistant turns on this machine: 4,383 toolUse, 124 stop,
// 40 error, 4 aborted. Tool-result isError records are failed COMMANDS, not failed turns, and the
// turn keeps running — they deliberately do not map to 'error'.
export function readPiExecutionStatus(records) {
  const turns = [];
  for (const record of records ?? []) {
    if (record?.type !== 'message' || record.message?.role !== 'assistant') continue;
    const message = record.message;
    const parts = contentParts(message);
    const hasToolCall = parts.some((part) => part?.type === 'toolCall');
    const hasText = parts.some((part) => part?.type === 'text' && nonEmptyText(part.text))
      || nonEmptyText(message.content);
    turns.push({ stopReason: typeof message.stopReason === 'string' ? message.stopReason : null, hasToolCall, hasText });
  }
  if (!turns.length) return 'unknown';
  const last = turns[turns.length - 1];
  if (last.stopReason === 'error') return 'error';
  if (last.stopReason === 'toolUse' || (last.stopReason === null && last.hasToolCall)) return 'working';
  // 'aborted' is a user interrupt: the run is no longer in flight and is not an Agent error, the
  // same way Codex's terminal projection treats an 'interrupted' turn as idle.
  if (last.stopReason === 'stop' || last.stopReason === 'aborted' || last.hasText) return 'idle';
  return 'unknown';
}
