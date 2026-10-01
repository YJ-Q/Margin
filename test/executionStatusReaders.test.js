import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readClaudeExecutionStatus, readPiExecutionStatus } from '../src/agents/executionStatus.js';

test('Claude status is unknown for empty / non-assistant transcripts', () => {
  assert.equal(readClaudeExecutionStatus([]), 'unknown');
  assert.equal(readClaudeExecutionStatus(null), 'unknown');
  assert.equal(readClaudeExecutionStatus([{ type: 'user', message: { role: 'user' } }]), 'unknown');
});

test('Claude status ignores sidechain assistant turns', () => {
  const records = [
    { type: 'assistant', isSidechain: true, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use' }] } },
  ];
  assert.equal(readClaudeExecutionStatus(records), 'unknown');
});

test('Claude status derives working from a tool_use block even on legacy records without stop_reason', () => {
  const records = [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }] } },
  ];
  assert.equal(readClaudeExecutionStatus(records), 'working');
});

test('Claude status treats plain string content answer as idle', () => {
  const records = [
    { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: 'here is the answer' } },
  ];
  assert.equal(readClaudeExecutionStatus(records), 'idle');
});

test('Claude status is unknown for an assistant turn with no content and no marker', () => {
  const records = [{ type: 'assistant', message: { role: 'assistant', model: 'm' } }];
  assert.equal(readClaudeExecutionStatus(records), 'unknown');
});

test('Pi status is unknown for empty transcripts and non-assistant messages', () => {
  assert.equal(readPiExecutionStatus([]), 'unknown');
  assert.equal(readPiExecutionStatus(null), 'unknown');
  assert.equal(readPiExecutionStatus([{ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }]), 'unknown');
  assert.equal(readPiExecutionStatus([{ type: 'session', id: 'x' }]), 'unknown');
});

test('Pi status derives working from a toolCall block on records without stopReason', () => {
  const records = [{ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', toolName: 'Read' }] } }];
  assert.equal(readPiExecutionStatus(records), 'working');
});

test('Pi status recognises every observed native terminal marker', () => {
  for (const [stopReason, expected] of [['toolUse', 'working'], ['stop', 'idle'], ['aborted', 'idle'], ['error', 'error']]) {
    assert.equal(readPiExecutionStatus([{ type: 'message', message: { role: 'assistant', stopReason, content: [{ type: 'text', text: 'x' }] } }]), expected, stopReason);
  }
});

test('Pi status is unknown for an assistant message with no marker and empty content', () => {
  assert.equal(readPiExecutionStatus([{ type: 'message', message: { role: 'assistant' } }]), 'unknown');
});
