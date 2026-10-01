import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDescriptor, normalizeDescriptor } from '../src/agents/descriptor/spec.js';
import { extractExecutionStatus } from '../src/agents/descriptor/readers.js';

// ---- Spec validation: executionStatus section ----

test('executionStatus.kind transcript validates with where, path, map', () => {
  const descriptor = {
    specVersion: 1,
    type: 'test-agent',
    label: 'Test',
    sessions: { kind: 'transcript', roots: ['{home}/sessions'], transcript: { glob: '*.jsonl', format: 'jsonl' },
      id: { kind: 'directoryName' }, createdAt: { kind: 'mtime', glob: '*', pick: 'min' }, updatedAt: { kind: 'mtime', glob: '*', pick: 'max' },
      workspace: { kind: 'scanAbsolutePaths', parentOf: true } },
    executionStatus: { kind: 'transcript', where: { type: 'event' }, path: 'payload.status', map: { started: 'working', done: 'idle', failed: 'error' } },
  };
  const result = validateDescriptor(descriptor);
  assert.ok(result.ok, `Expected valid, got errors: ${result.errors.join('; ')}`);
});

test('executionStatus.kind none validates', () => {
  const descriptor = {
    specVersion: 1, type: 'test-agent', label: 'Test',
    sessions: { kind: 'transcript', roots: ['{home}/sessions'], transcript: { glob: '*.jsonl', format: 'jsonl' },
      id: { kind: 'directoryName' }, createdAt: { kind: 'mtime', glob: '*', pick: 'min' }, updatedAt: { kind: 'mtime', glob: '*', pick: 'max' },
      workspace: { kind: 'scanAbsolutePaths', parentOf: true } },
    executionStatus: { kind: 'none' },
  };
  const result = validateDescriptor(descriptor);
  assert.ok(result.ok, `Expected valid, got errors: ${result.errors.join('; ')}`);
});

test('executionStatus.kind builtin without sessions.kind builtin fails', () => {
  const descriptor = {
    specVersion: 1, type: 'test-agent', label: 'Test',
    sessions: { kind: 'transcript', roots: ['{home}/sessions'], transcript: { glob: '*.jsonl', format: 'jsonl' },
      id: { kind: 'directoryName' }, createdAt: { kind: 'mtime', glob: '*', pick: 'min' }, updatedAt: { kind: 'mtime', glob: '*', pick: 'max' },
      workspace: { kind: 'scanAbsolutePaths', parentOf: true } },
    executionStatus: { kind: 'builtin' },
  };
  const result = validateDescriptor(descriptor);
  assert.ok(!result.ok, 'Expected validation failure');
  assert.ok(result.errors.some((e) => e.includes('executionStatus.kind builtin requires sessions.kind builtin')));
});

test('capabilities.executionStatus true without executionStatus section fails for non-builtin', () => {
  const descriptor = {
    specVersion: 1, type: 'test-agent', label: 'Test',
    capabilities: { executionStatus: true },
    sessions: { kind: 'transcript', roots: ['{home}/sessions'], transcript: { glob: '*.jsonl', format: 'jsonl' },
      id: { kind: 'directoryName' }, createdAt: { kind: 'mtime', glob: '*', pick: 'min' }, updatedAt: { kind: 'mtime', glob: '*', pick: 'max' },
      workspace: { kind: 'scanAbsolutePaths', parentOf: true } },
  };
  const result = validateDescriptor(descriptor);
  assert.ok(!result.ok, 'Expected validation failure');
  assert.ok(result.errors.some((e) => e.includes('capabilities.executionStatus is true but executionStatus.kind is none or missing')));
});

test('executionStatus.kind transcript without path fails', () => {
  const descriptor = {
    specVersion: 1, type: 'test-agent', label: 'Test',
    sessions: { kind: 'transcript', roots: ['{home}/sessions'], transcript: { glob: '*.jsonl', format: 'jsonl' },
      id: { kind: 'directoryName' }, createdAt: { kind: 'mtime', glob: '*', pick: 'min' }, updatedAt: { kind: 'mtime', glob: '*', pick: 'max' },
      workspace: { kind: 'scanAbsolutePaths', parentOf: true } },
    executionStatus: { kind: 'transcript', map: { started: 'working' } },
  };
  const result = validateDescriptor(descriptor);
  assert.ok(!result.ok);
  assert.ok(result.errors.some((e) => e.includes('executionStatus.path is required')));
});

test('executionStatus.map with invalid status value fails', () => {
  const descriptor = {
    specVersion: 1, type: 'test-agent', label: 'Test',
    sessions: { kind: 'transcript', roots: ['{home}/sessions'], transcript: { glob: '*.jsonl', format: 'jsonl' },
      id: { kind: 'directoryName' }, createdAt: { kind: 'mtime', glob: '*', pick: 'min' }, updatedAt: { kind: 'mtime', glob: '*', pick: 'max' },
      workspace: { kind: 'scanAbsolutePaths', parentOf: true } },
    executionStatus: { kind: 'transcript', path: 'status', map: { started: 'running' } },
  };
  const result = validateDescriptor(descriptor);
  assert.ok(!result.ok);
  assert.ok(result.errors.some((e) => e.includes('must be one of')));
});

// ---- Normalization ----

test('normalizeDescriptor preserves executionStatus transcript section with defaults', () => {
  const descriptor = {
    specVersion: 1, type: 'test-agent', label: 'Test',
    sessions: { kind: 'transcript', roots: ['{home}/sessions'], transcript: { glob: '*.jsonl', format: 'jsonl' },
      id: { kind: 'directoryName' }, createdAt: { kind: 'mtime', glob: '*', pick: 'min' }, updatedAt: { kind: 'mtime', glob: '*', pick: 'max' },
      workspace: { kind: 'scanAbsolutePaths', parentOf: true } },
    executionStatus: { kind: 'transcript', where: { type: 'event' }, path: 'status', map: { started: 'working', done: 'idle' } },
  };
  const normalized = normalizeDescriptor(descriptor);
  assert.equal(normalized.executionStatus.kind, 'transcript');
  assert.deepEqual(normalized.executionStatus.where, { type: 'event' });
  assert.equal(normalized.executionStatus.path, 'status');
  assert.equal(normalized.executionStatus.pick, 'last'); // default
  assert.equal(normalized.executionStatus.map.started, 'working');
});

test('normalizeDescriptor sets executionStatus null when absent', () => {
  const descriptor = {
    specVersion: 1, type: 'test-agent', label: 'Test',
    sessions: { kind: 'transcript', roots: ['{home}/sessions'], transcript: { glob: '*.jsonl', format: 'jsonl' },
      id: { kind: 'directoryName' }, createdAt: { kind: 'mtime', glob: '*', pick: 'min' }, updatedAt: { kind: 'mtime', glob: '*', pick: 'max' },
      workspace: { kind: 'scanAbsolutePaths', parentOf: true } },
  };
  const normalized = normalizeDescriptor(descriptor);
  assert.equal(normalized.executionStatus, null);
});

// ---- extractExecutionStatus ----

test('extractExecutionStatus returns unknown when no records match where', () => {
  const spec = { kind: 'transcript', where: { type: 'event' }, path: 'status', map: { started: 'working' } };
  const records = [{ type: 'message', status: 'started' }];
  assert.equal(extractExecutionStatus(spec, records), 'unknown');
});

test('extractExecutionStatus returns mapped value from last matching record by default', () => {
  const spec = { kind: 'transcript', where: { type: 'event' }, path: 'status', map: { started: 'working', done: 'idle', failed: 'error' } };
  const records = [
    { type: 'event', status: 'started' },
    { type: 'event', status: 'done' },
  ];
  assert.equal(extractExecutionStatus(spec, records), 'idle'); // last match wins
});

test('extractExecutionStatus respects pick: first', () => {
  const spec = { kind: 'transcript', where: { type: 'event' }, path: 'status', map: { started: 'working', done: 'idle' }, pick: 'first' };
  const records = [
    { type: 'event', status: 'started' },
    { type: 'event', status: 'done' },
  ];
  assert.equal(extractExecutionStatus(spec, records), 'working'); // first match wins
});

test('extractExecutionStatus returns unknown when mapped value not in map', () => {
  const spec = { kind: 'transcript', where: { type: 'event' }, path: 'status', map: { started: 'working' } };
  const records = [{ type: 'event', status: 'paused' }];
  assert.equal(extractExecutionStatus(spec, records), 'unknown');
});

test('extractExecutionStatus returns unknown when path field is absent', () => {
  const spec = { kind: 'transcript', where: { type: 'event' }, path: 'status', map: { started: 'working' } };
  const records = [{ type: 'event' }];
  assert.equal(extractExecutionStatus(spec, records), 'unknown');
});

test('extractExecutionStatus handles dotted path', () => {
  const spec = { kind: 'transcript', where: { type: 'event' }, path: 'payload.status', map: { running: 'working' } };
  const records = [{ type: 'event', payload: { status: 'running' } }];
  assert.equal(extractExecutionStatus(spec, records), 'working');
});

test('extractExecutionStatus returns unknown for null spec', () => {
  assert.equal(extractExecutionStatus(null, []), 'unknown');
  assert.equal(extractExecutionStatus({ kind: 'none' }, [{ type: 'event' }]), 'unknown');
});

test('extractExecutionStatus handles numeric path values', () => {
  const spec = { kind: 'transcript', where: { type: 'event' }, path: 'code', map: { '0': 'idle', '1': 'working', '2': 'error' } };
  const records = [{ type: 'event', code: 1 }];
  assert.equal(extractExecutionStatus(spec, records), 'working');
});
