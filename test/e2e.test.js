import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir, fakeLLM, reply } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'test-token';
const PORT = 39000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = tmpDir();
let server, llm;

const api = async (method, url, body) => {
  const res = await fetch(BASE + url, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${data.error}`);
  return data;
};

/** Collect SSE events for a session; `onEvent` may react (e.g. approve permissions). Resolves on "done". */
async function runAndCollect(sessionId, text, mode, onEvent = () => {}) {
  const res = await fetch(`${BASE}/api/sessions/${sessionId}/events`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const reader = res.body.getReader();
  const events = [];
  await api('POST', `/api/sessions/${sessionId}/messages`, { text, mode });
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!chunk.startsWith('data: ')) continue;
      const ev = JSON.parse(chunk.slice(6));
      events.push(ev);
      await onEvent(ev);
      if (ev.type === 'done') { reader.cancel(); return events; }
    }
  }
  return events;
}

before(async () => {
  llm = await fakeLLM([]);
  server = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT), HOST: '127.0.0.1', ACCESS_TOKEN: TOKEN, LLM_PROVIDER: 'custom', LLM_BASE_URL: llm.url, LLM_MODEL: 'fake-model', LLM_API_KEY: 'x', GITHUB_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start: ' + log);
});

after(() => { server?.kill(); llm?.close(); });

test('rejects unauthenticated API calls', async () => {
  const res = await fetch(BASE + '/api/workspaces');
  assert.equal(res.status, 401);
  const login = await fetch(BASE + '/api/login', { method: 'POST', body: JSON.stringify({ token: 'wrong' }) });
  assert.equal(login.status, 401);
});

test('agent edits files, runs commands with approval, branches and commits', async () => {
  await api('POST', '/api/workspaces', { name: 'demo' });
  const s = await api('POST', '/api/sessions', { workspace: 'demo', mode: 'acceptEdits' });

  llm.script.push(
    reply.tools(['todo_write', { todos: [{ content: 'Create script', status: 'in_progress' }, { content: 'Commit', status: 'pending' }] }]),
    reply.tools(['git_branch', { action: 'create', name: 'feature/hello' }], ['write_file', { path: 'hello.py', content: 'print("hi")\n' }]),
    reply.tools(['bash', { command: 'python3 hello.py' }]),
    reply.tools(['git_commit', { message: 'Add hello script' }]),
    reply.text('Created `hello.py` on branch feature/hello and committed it.'),
  );

  const events = await runAndCollect(s.id, 'Create a hello world python script and commit it on a branch', 'acceptEdits', async (ev) => {
    if (ev.type === 'permission_request') {
      assert.equal(ev.name, 'bash');
      await api('POST', `/api/sessions/${s.id}/permission`, { requestId: ev.requestId, decision: 'allow' });
    }
  });

  const types = events.map((e) => e.type);
  assert.ok(types.includes('permission_request'), 'bash must ask in acceptEdits mode');
  assert.ok(types.includes('todos'));
  const bashResult = events.find((e) => e.type === 'tool_result' && e.name === 'bash');
  assert.match(bashResult.content, /hi\n[\s\S]*Exit code: 0/);
  const writeResult = events.find((e) => e.type === 'tool_result' && e.name === 'write_file');
  assert.equal(writeResult.display.type, 'diff');
  assert.ok(!events.some((e) => e.type === 'error'), JSON.stringify(events.filter((e) => e.type === 'error')));

  const ws = path.join(dataDir, 'workspaces/demo');
  assert.equal(fs.readFileSync(path.join(ws, 'hello.py'), 'utf8'), 'print("hi")\n');
  assert.equal(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ws }).toString().trim(), 'feature/hello');
  assert.match(execFileSync('git', ['log', '--oneline'], { cwd: ws }).toString(), /Add hello script/);

  // Tool results were sent back to the model in OpenAI format.
  const last = llm.requests.at(-1);
  assert.equal(last.messages[0].role, 'system');
  assert.ok(last.messages.some((m) => m.role === 'tool' && /hi/.test(m.content)));
  assert.ok(last.tools.some((t) => t.function.name === 'edit_file'));

  const saved = await api('GET', `/api/sessions/${s.id}`);
  assert.equal(saved.status.running, false);
  assert.equal(saved.todos.length, 2);
  assert.equal(saved.messages.at(-1).content, 'Created `hello.py` on branch feature/hello and committed it.');

  const git = await api('GET', '/api/workspaces/demo/git');
  assert.equal(git.branch, 'feature/hello');
  assert.equal(git.files.length, 0);
});

test('denied permission and plan mode are reported back to the model', async () => {
  const s = await api('POST', '/api/sessions', { workspace: 'demo', mode: 'plan' });
  llm.script.push(
    reply.tools(['write_file', { path: 'x.txt', content: 'nope' }]),
    reply.text('Plan: 1. create x.txt'),
  );
  const events = await runAndCollect(s.id, 'make x.txt', 'plan');
  const r = events.find((e) => e.type === 'tool_result');
  assert.equal(r.isError, true);
  assert.match(r.content, /Plan mode is read-only/);
  assert.ok(!fs.existsSync(path.join(dataDir, 'workspaces/demo/x.txt')));

  await api('PATCH', `/api/sessions/${s.id}`, { mode: 'ask' });
  llm.script.push(reply.tools(['bash', { command: 'touch y.txt' }]), reply.text('ok, not doing it'));
  const events2 = await runAndCollect(s.id, 'touch y', 'ask', async (ev) => {
    if (ev.type === 'permission_request') await api('POST', `/api/sessions/${s.id}/permission`, { requestId: ev.requestId, decision: 'deny', feedback: 'use python instead' });
  });
  const r2 = events2.find((e) => e.type === 'tool_result');
  assert.match(r2.content, /denied[\s\S]*use python instead/);
  assert.ok(!fs.existsSync(path.join(dataDir, 'workspaces/demo/y.txt')));
});

test('stop interrupts a long-running command', async () => {
  const s = await api('POST', '/api/sessions', { workspace: 'demo', mode: 'auto' });
  llm.script.push(reply.tools(['bash', { command: 'sleep 30' }]));
  const started = Date.now();
  const events = await runAndCollect(s.id, 'sleep', 'auto', async (ev) => {
    if (ev.type === 'tool_call') setTimeout(() => api('POST', `/api/sessions/${s.id}/stop`), 300);
  });
  assert.ok(Date.now() - started < 10_000);
  assert.ok(events.some((e) => e.type === 'done'));
  const saved = await api('GET', `/api/sessions/${s.id}`);
  const toolMsg = saved.messages.find((m) => m.role === 'tool');
  assert.ok(toolMsg, 'tool call must be closed with a result');
});

test('slash command /clear and file API', async () => {
  const s = await api('POST', '/api/sessions', { workspace: 'demo', mode: 'ask' });
  llm.script.push(reply.text('hello'));
  await runAndCollect(s.id, 'hi', 'ask');
  await api('POST', `/api/sessions/${s.id}/messages`, { text: '/clear' });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await api('GET', `/api/sessions/${s.id}`)).messages.length, 0);

  const tree = await api('GET', '/api/workspaces/demo/tree');
  assert.ok(tree.some((f) => f.name === 'hello.py'));
  assert.equal((await api('GET', '/api/workspaces/demo/file?path=hello.py')).content, 'print("hi")\n');
  const bad = await fetch(`${BASE}/api/workspaces/demo/file?path=../../settings.json`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(bad.status, 400);
  const cmds = await api('GET', '/api/workspaces/demo/commands');
  assert.ok(cmds.some((c) => c.name === 'init'));
});
