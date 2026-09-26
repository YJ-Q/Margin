// Sandbox-scoped tools for tested recovery runs.
// Every file access is contained to the run sandbox root. The shell is guarded and
// every invocation is audited. No built-in pi tools are exposed to the tested agent.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const { Type } = require('typebox');

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svgz', '.woff', '.woff2', '.ttf', '.eot',
  '.sqlite', '.sqlite3', '.db', '.dll', '.exe', '.so', '.dylib', '.node', '.wasm', '.pdf', '.zip',
  '.gz', '.tar', '.7z', '.rar', '.pyc', '.pack', '.idx', '.obj', '.bin', '.class', '.jar'
]);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'out', 'out2', 'out-electron', '.margin', 'data', '.runtime', 'dist']);

function norm(p) {
  return path.normalize(p).toLowerCase().replace(/\\/g, '/');
}

function resolveInside(root, p) {
  const rootNorm = norm(root);
  let target;
  try {
    target = path.resolve(root, p || '.');
  } catch {
    return null;
  }
  const t = norm(target);
  if (t === rootNorm) return target;
  if (t.startsWith(rootNorm + '/')) return target;
  return null;
}

function looksBinary(buf) {
  if (buf.length === 0) return false;
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) return true;
  // heuristic utf8 validity
  const s = buf.toString('utf8', 0, 8192);
  let bad = 0;
  for (let i = 0; i < s.length; i++) {
    const cc = s.charCodeAt(i);
    if (cc === 0xfffd) bad++;
  }
  return bad > s.length * 0.02;
}

export function buildDenyReasons(command, sandboxRoot) {
  const rootNorm = norm(sandboxRoot);
  const c = command.toLowerCase();
  const reasons = [];
  if (/https?:|invoke-webrequest|invoke-restmethod|\biwr\b|\birm\b|\bcurl\b|\bwget\b|webclient|start-bits|tcpclient|new-object net\./.test(c)) {
    reasons.push('network access is disabled in the isolated environment');
  }
  if (/[-/]enc(?:odedcommand)?\b|encodedcommand/.test(c)) {
    reasons.push('encoded command payloads are disabled');
  }
  if (/\$env:|%\w+%|process\.env\./.test(c)) {
    reasons.push('environment-variable expansion is disabled');
  }
  if (/(^|[^\\/\w])\.\.([\\/]|$)/.test(c)) {
    reasons.push('parent-directory traversal is disabled');
  }
  const driveRe = /(^|[^a-z0-9])([a-z]):[\\/]/g;
  let m;
  while ((m = driveRe.exec(c))) {
    const rest = c.slice(m.index + m[0].length);
    const tokEnd = rest.search(/[\s"';&|><]/);
    const token = rest.slice(0, tokEnd === -1 ? rest.length : tokEnd).replace(/\\/g, '/');
    const cand = (m[2] + ':/' + token).toLowerCase().replace(/\/+/g, '/');
    const drivePrefix = cand.split('/').slice(0, 2).join('/');
    if (!drivePrefix.startsWith('c:/windows')) {
      if (!cand.startsWith(rootNorm)) {
        reasons.push(`absolute path outside the sandbox is disabled: ${m[2]}:\\${token}`);
        break;
      }
    }
  }
  const protectedFrag = [
    '\\code\\margin\\', // real repository (contains protected validation content)
    '\\docs\\validation', 'recovery-handoffs', 'recovery-benchmark-ground-truth',
    'continuation-ab-deepseek-runs', 'margin_recovery_benchmark', 'margin_handoff_compression_benchmark',
    '\\.pi', '\\.codex', '\\archived_sessions', '\\.margin', '\\handoff-output', '\\.claude', '\\.superpowers'
  ];
  for (const f of protectedFrag) {
    if (c.includes(f)) { reasons.push(`protected path fragment is disabled: ${f}`); break; }
  }
  if (c.startsWith('\\\\')) reasons.push('UNC paths are disabled');
  return reasons;
}

function createSandboxTools({ sandboxRoot, audit, defineTool }) {
  const tools = [];

  const readTool = defineTool({
    name: 'read_file',
    label: 'Read file',
    description:
      'Read a text file inside the isolated environment. `path` is relative to the environment root or an absolute path inside it. Optional `offsetChars`/`limitChars` page through large files. Never modify anything.',
    parameters: Type.Object({
      path: Type.String({ description: 'Path of the file to read' }),
      offsetChars: Type.Optional(Type.Number({ description: 'Character offset to start from (default 0)' })),
      limitChars: Type.Optional(Type.Number({ description: 'Maximum characters to return (default 100000)' }))
    }),
    execute: async (_id, params) => {
      audit.log('read_file', params);
      const target = resolveInside(sandboxRoot, params.path);
      if (!target) return { content: [{ type: 'text', text: 'ERROR: path resolves outside the isolated environment' }], isError: true };
      try {
        const st = fs.statSync(target);
        if (st.isDirectory()) return { content: [{ type: 'text', text: 'ERROR: path is a directory' }], isError: true };
        const buf = fs.readFileSync(target);
        if (looksBinary(buf)) return { content: [{ type: 'text', text: 'ERROR: binary file, use run_command to inspect' }], isError: true };
        let text = buf.toString('utf8');
        const offset = Math.max(0, Math.floor(params.offsetChars ?? 0));
        const limit = Math.min(400000, Math.floor(params.limitChars ?? 100000));
        const total = text.length;
        const sliced = text.slice(offset, offset + limit);
        const note = total > offset + limit ? `\n...[truncated: showing chars ${offset}-${offset + sliced.length} of ${total}]` : '';
        return { content: [{ type: 'text', text: sliced + note }], isError: false };
      } catch (e) {
        return { content: [{ type: 'text', text: `ERROR: ${e.message}` }], isError: true };
      }
    }
  });

  const listTool = defineTool({
    name: 'list_directory',
    label: 'List directory',
    description:
      'List entries of a directory inside the isolated environment. Directories end with "/". Use "." for the environment root.',
    parameters: Type.Object({
      path: Type.String({ description: 'Directory path (default ".")' })
    }),
    execute: async (_id, params) => {
      audit.log('list_directory', params);
      const target = resolveInside(sandboxRoot, params.path || '.');
      if (!target) return { content: [{ type: 'text', text: 'ERROR: path resolves outside the isolated environment' }], isError: true };
      try {
        const entries = fs.readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
        const lines = entries.map((e) => (e.isDirectory() ? e.name + '/' : e.name));
        if (lines.length === 0) return { content: [{ type: 'text', text: '(empty)' }], isError: false };
        return { content: [{ type: 'text', text: lines.join('\n') }], isError: false };
      } catch (e) {
        return { content: [{ type: 'text', text: `ERROR: ${e.message}` }], isError: true };
      }
    }
  });

  const grepTool = defineTool({
    name: 'grep_files',
    label: 'Grep files',
    description:
      'Search file contents inside the isolated environment with a JavaScript regular expression (case-insensitive unless `caseSensitive`). Returns up to `maxResults` matches as "path:line: text".',
    parameters: Type.Object({
      pattern: Type.String({ description: 'Regular expression to search for' }),
      path: Type.Optional(Type.String({ description: 'Directory or file to search (default: environment root)' })),
      caseSensitive: Type.Optional(Type.Boolean({ description: 'Case-sensitive search (default false)' })),
      maxResults: Type.Optional(Type.Number({ description: 'Maximum results (default 200)' }))
    }),
    execute: async (_id, params) => {
      audit.log('grep_files', params);
      const target = resolveInside(sandboxRoot, params.path || '.');
      if (!target) return { content: [{ type: 'text', text: 'ERROR: path resolves outside the isolated environment' }], isError: true };
      let re;
      try {
        re = new RegExp(params.pattern, params.caseSensitive ? '' : 'i');
      } catch (e) {
        return { content: [{ type: 'text', text: `ERROR: invalid pattern: ${e.message}` }], isError: true };
      }
      const max = Math.min(300, Math.floor(params.maxResults ?? 200));
      const out = [];
      const walk = (dir, depth) => {
        if (depth > 14) return;
        let ents;
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          if (out.length >= max) return;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name)) continue;
            walk(full, depth + 1);
          } else if (e.isFile()) {
            const ext = path.extname(e.name).toLowerCase();
            if (BINARY_EXT.has(ext)) continue;
            if (e.name.endsWith('.jsonl') || e.name.endsWith('.json')) { /* still allow */ }
            try {
              const buf = fs.readFileSync(full);
              if (looksBinary(buf)) continue;
              const text = buf.toString('utf8');
              const lines = text.split('\n');
              for (let i = 0; i < lines.length && out.length < max; i++) {
                if (re.test(lines[i])) {
                  const rel = path.relative(sandboxRoot, full).replace(/\\/g, '/');
                  const snippet = lines[i].length > 400 ? lines[i].slice(0, 400) + '...' : lines[i];
                  out.push(`${rel}:${i + 1}: ${snippet}`);
                  if (out.length >= max) break;
                }
              }
            } catch { /* skip unreadable */ }
          }
        }
      };
      walk(target, 0);
      if (out.length === 0) return { content: [{ type: 'text', text: '(no matches)' }], isError: false };
      const note = out.length >= max ? `\n...(truncated at ${max} matches)` : '';
      return { content: [{ type: 'text', text: out.join('\n') + note }], isError: false };
    }
  });

  const shellTool = defineTool({
    name: 'run_command',
    label: 'Run read-only command',
    description:
      'Run a PowerShell 5.1 command inside the isolated environment. Current directory is the environment root. Network, home-profile, environment-variable expansion, parent traversal, and access to anything outside this environment are disabled and will be refused. Use this to inspect repository history (git status/log/diff in ./workspace), parse the ./input artifact, or search files. Example: Get-Content .\\input\\session.jsonl -TotalCount 40',
    parameters: Type.Object({
      command: Type.String({ description: 'PowerShell command text' })
    }),
    execute: async (_id, params) => {
      audit.log('run_command', { command: params.command });
      const reasons = buildDenyReasons(params.command, sandboxRoot);
      if (reasons.length > 0) {
        audit.deny(params.command, reasons);
        return { content: [{ type: 'text', text: `DENIED: ${reasons.join('; ')}` }], isError: true };
      }
      return await runGuardedPowerShell(params.command, sandboxRoot);
    }
  });

  tools.push(readTool, listTool, grepTool, shellTool);
  return tools;
}

function runGuardedPowerShell(command, sandboxRoot) {
  return new Promise((resolve) => {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const psPath = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const env = {
      SystemRoot: systemRoot,
      ComSpec: path.join(systemRoot, 'System32', 'cmd.exe'),
      PATH: [
        path.join(systemRoot, 'System32'),
        path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
        path.dirname(process.execPath)
      ].join(';'),
      HOME: path.join(sandboxRoot, '_tmp'),
      USERPROFILE: path.join(sandboxRoot, '_tmp'),
      TEMP: path.join(sandboxRoot, '_tmp'),
      TMP: path.join(sandboxRoot, '_tmp')
    };
    if (process.env.BENCH_GIT_DIR) env.PATH += ';' + process.env.BENCH_GIT_DIR;
    const child = spawn(psPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      cwd: sandboxRoot,
      env,
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
    }, 90000);
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); if (stdout.length > 300000) stdout = stdout.slice(-300000); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); if (stderr.length > 300000) stderr = stderr.slice(-300000); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ content: [{ type: 'text', text: `ERROR: ${err.message}` }], isError: true });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const out = (stdout.length ? stdout + (stderr.length ? '\n[stderr]\n' + stderr : '') : stderr);
      const text = out.length > 250000 ? out.slice(0, 250000) + '\n...(output truncated)' : out;
      const terminated = code === null;
      resolve({
        content: [{ type: 'text', text: (terminated ? '[timed out after 90s]\n' : '') + (text || '(no output)') + `\n[exit code: ${code === null ? 'timeout' : code}]` }],
        isError: false
      });
    });
  });
}

export { createSandboxTools };
