#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT_DIR, PROVIDER_PRESETS, getSettings, updateSettings, publicSettings, getAccessToken } from './config.js';
import * as ws from './workspaces.js';
import * as sessions from './sessions.js';
import * as runtime from './runtime.js';
import { listCommands } from './agent/commands.js';
import { MODES } from './tools/index.js';
import { chat } from './llm/provider.js';
import { gh, repoFromWorkspace } from './github/api.js';
import { verifySignature, parseEvent, handleTask } from './github/webhook.js';
import { mcpStatus, shutdownMcp } from './mcp/client.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const WEB_DIR = path.join(ROOT_DIR, 'web');
const ACCESS_TOKEN = getAccessToken();
const COOKIE_VALUE = crypto.createHash('sha256').update('codeagent:' + ACCESS_TOKEN).digest('hex');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function send(res, status, data) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function json(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function authed(req) {
  if (safeEqual(parseCookies(req).ca_session, COOKIE_VALUE)) return true;
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') && safeEqual(h.slice(7), ACCESS_TOKEN);
}

const loginAttempts = new Map();

function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(WEB_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(WEB_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB_DIR, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

// Webhook tasks are serialized per repository so two runs never share a checkout.
const repoQueues = new Map();
function enqueueTask(task) {
  const prev = repoQueues.get(task.repo) || Promise.resolve();
  const next = prev.then(() => handleTask(task)).catch(() => {});
  repoQueues.set(task.repo, next);
}

async function workspaceRepo(name) {
  const r = await repoFromWorkspace(ws.workspacePath(name));
  if (!r) throw new HttpError(400, 'Workspace has no github.com origin remote');
  return `${r.owner}/${r.repo}`;
}

/** Route table: [method, regex, handler(req, res, match, url)] */
const routes = [
  ['POST', /^\/api\/login$/, async (req, res) => {
    const ip = req.socket.remoteAddress;
    const a = loginAttempts.get(ip) || { n: 0, t: Date.now() };
    if (Date.now() - a.t > 15 * 60_000) { a.n = 0; a.t = Date.now(); }
    if (a.n >= 10) throw new HttpError(429, 'Too many attempts, try again later');
    const { token } = await json(req);
    if (!safeEqual(token, ACCESS_TOKEN)) { a.n++; loginAttempts.set(ip, a); throw new HttpError(401, 'Invalid access token'); }
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `ca_session=${COOKIE_VALUE}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 30}${secure}`);
    send(res, 200, { ok: true });
  }],
  ['POST', /^\/api\/logout$/, async (req, res) => {
    res.setHeader('Set-Cookie', 'ca_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    send(res, 200, { ok: true });
  }],
  ['GET', /^\/api\/me$/, async (req, res) => send(res, 200, { ok: true, modes: MODES })],

  // Settings & providers
  ['GET', /^\/api\/settings$/, async (req, res) => send(res, 200, publicSettings())],
  ['PUT', /^\/api\/settings$/, async (req, res) => { updateSettings(await json(req)); send(res, 200, publicSettings()); }],
  ['GET', /^\/api\/providers$/, async (req, res) => send(res, 200, PROVIDER_PRESETS)],
  ['POST', /^\/api\/llm\/test$/, async (req, res) => {
    const started = Date.now();
    const r = await chat(getSettings().llm, { messages: [{ role: 'user', content: 'Reply with exactly: OK' }], maxTokens: 20 });
    send(res, 200, { ok: true, reply: r.content, model: r.model, ms: Date.now() - started });
  }],
  ['GET', /^\/api\/mcp$/, async (req, res) => send(res, 200, mcpStatus())],

  // GitHub (account level)
  ['GET', /^\/api\/github\/repos$/, async (req, res) => {
    const repos = await gh('GET', '/user/repos?per_page=100&sort=pushed');
    send(res, 200, repos.map((r) => ({ full_name: r.full_name, private: r.private, clone_url: r.clone_url, default_branch: r.default_branch, pushed_at: r.pushed_at, description: r.description })));
  }],
  ['GET', /^\/api\/github\/user$/, async (req, res) => { const u = await gh('GET', '/user'); send(res, 200, { login: u.login, avatar_url: u.avatar_url }); }],

  // Workspaces
  ['GET', /^\/api\/workspaces$/, async (req, res) => send(res, 200, await ws.listWorkspaces())],
  ['POST', /^\/api\/workspaces$/, async (req, res) => send(res, 201, await ws.createWorkspace(await json(req)))],
  ['DELETE', /^\/api\/workspaces\/([^/]+)$/, async (req, res, m) => { ws.deleteWorkspace(m[1]); send(res, 200, { ok: true }); }],
  ['GET', /^\/api\/workspaces\/([^/]+)\/tree$/, async (req, res, m, url) => send(res, 200, ws.listDir(m[1], url.searchParams.get('path') || '.'))],
  ['GET', /^\/api\/workspaces\/([^/]+)\/file$/, async (req, res, m, url) => send(res, 200, ws.readFile(m[1], url.searchParams.get('path')))],
  ['PUT', /^\/api\/workspaces\/([^/]+)\/file$/, async (req, res, m, url) => { const b = await json(req); ws.writeFile(m[1], url.searchParams.get('path'), b.content ?? ''); send(res, 200, { ok: true }); }],
  ['GET', /^\/api\/workspaces\/([^/]+)\/git$/, async (req, res, m) => send(res, 200, await ws.gitInfo(m[1]))],
  ['GET', /^\/api\/workspaces\/([^/]+)\/diff$/, async (req, res, m, url) => send(res, 200, { diff: await ws.gitDiff(m[1], url.searchParams.get('path')) })],
  ['POST', /^\/api\/workspaces\/([^/]+)\/git$/, async (req, res, m) => send(res, 200, { output: await ws.gitAction(m[1], await json(req)) })],
  ['GET', /^\/api\/workspaces\/([^/]+)\/commands$/, async (req, res, m) => send(res, 200, listCommands(ws.workspacePath(m[1])))],
  ['GET', /^\/api\/workspaces\/([^/]+)\/github\/(pulls|issues)$/, async (req, res, m, url) => {
    const repo = await workspaceRepo(m[1]);
    const items = await gh('GET', `/repos/${repo}/${m[2]}?state=${url.searchParams.get('state') || 'open'}&per_page=50`);
    send(res, 200, { repo, items: items.filter((i) => m[2] === 'pulls' || !i.pull_request).map((i) => ({ number: i.number, title: i.title, state: i.state, draft: i.draft, user: i.user?.login, url: i.html_url, head: i.head?.ref, base: i.base?.ref, updated_at: i.updated_at })) });
  }],
  ['POST', /^\/api\/workspaces\/([^/]+)\/github\/pulls$/, async (req, res, m) => {
    const repo = await workspaceRepo(m[1]);
    const b = await json(req);
    const base = b.base || (await gh('GET', `/repos/${repo}`)).default_branch;
    const pr = await gh('POST', `/repos/${repo}/pulls`, { title: b.title, body: b.body || '', head: b.head, base, draft: !!b.draft });
    send(res, 201, { number: pr.number, url: pr.html_url });
  }],
  ['POST', /^\/api\/workspaces\/([^/]+)\/github\/pulls\/(\d+)\/merge$/, async (req, res, m) => {
    const repo = await workspaceRepo(m[1]);
    const b = await json(req);
    send(res, 200, await gh('PUT', `/repos/${repo}/pulls/${m[2]}/merge`, { merge_method: b.method || 'squash' }));
  }],

  // Sessions
  ['GET', /^\/api\/sessions$/, async (req, res, m, url) => send(res, 200, sessions.listSessions(url.searchParams.get('workspace')))],
  ['POST', /^\/api\/sessions$/, async (req, res) => {
    const b = await json(req);
    ws.workspacePath(b.workspace);
    send(res, 201, sessions.createSession({ workspace: b.workspace, mode: MODES.includes(b.mode) ? b.mode : getSettings().agent.defaultMode }));
  }],
  ['GET', /^\/api\/sessions\/([\w-]+)$/, async (req, res, m) => {
    const s = runtime.currentSession(m[1]);
    if (!s) throw new HttpError(404, 'Session not found');
    send(res, 200, { ...s, status: runtime.status(m[1]) });
  }],
  ['PATCH', /^\/api\/sessions\/([\w-]+)$/, async (req, res, m) => {
    const s = runtime.currentSession(m[1]);
    if (!s) throw new HttpError(404, 'Session not found');
    const b = await json(req);
    if (b.mode && MODES.includes(b.mode)) s.mode = b.mode;
    if (b.title) s.title = String(b.title).slice(0, 120);
    sessions.saveSession(s);
    send(res, 200, { ok: true, mode: s.mode, title: s.title });
  }],
  ['DELETE', /^\/api\/sessions\/([\w-]+)$/, async (req, res, m) => { runtime.forget(m[1]); sessions.deleteSession(m[1]); send(res, 200, { ok: true }); }],
  ['POST', /^\/api\/sessions\/([\w-]+)\/messages$/, async (req, res, m) => {
    const b = await json(req);
    if (!b.text?.trim()) throw new HttpError(400, 'Empty message');
    if (runtime.status(m[1]).running) throw new HttpError(409, 'Agent is already running');
    runtime.sendMessage(m[1], b.text, { mode: b.mode }).catch((e) => console.error(e));
    send(res, 202, { ok: true });
  }],
  ['GET', /^\/api\/sessions\/([\w-]+)\/events$/, async (req, res, m) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(': connected\n\n');
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => clearInterval(ping));
    runtime.subscribe(m[1], res);
  }],
  ['POST', /^\/api\/sessions\/([\w-]+)\/stop$/, async (req, res, m) => { runtime.stop(m[1]); send(res, 200, { ok: true }); }],
  ['POST', /^\/api\/sessions\/([\w-]+)\/permission$/, async (req, res, m) => {
    const b = await json(req);
    if (!['allow', 'always', 'deny'].includes(b.decision)) throw new HttpError(400, 'decision must be allow|always|deny');
    send(res, 200, { ok: runtime.respondPermission(m[1], b.requestId, b.decision, b.feedback) });
  }],
];

async function handleWebhook(req, res) {
  const raw = await readBody(req, 25 * 1024 * 1024);
  const { webhookSecret, triggerPhrase } = getSettings().github;
  if (!verifySignature(webhookSecret, raw, req.headers['x-hub-signature-256'])) throw new HttpError(401, 'Invalid signature (is the webhook secret configured?)');
  const event = req.headers['x-github-event'];
  if (event === 'ping') return send(res, 200, { ok: true, pong: true });
  const task = parseEvent(event, JSON.parse(raw.toString('utf8')), triggerPhrase);
  if (!task) return send(res, 200, { ok: true, ignored: 'no trigger' });
  if (task.ignored) return send(res, 200, { ok: true, ignored: task.ignored });
  enqueueTask(task);
  send(res, 202, { ok: true, queued: `${task.repo}#${task.number}` });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  try {
    if (pathname === '/api/github/webhook' && req.method === 'POST') return await handleWebhook(req, res);
    if (pathname === '/healthz') return send(res, 200, 'ok');
    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
    if (pathname !== '/api/login' && !authed(req)) throw new HttpError(401, 'Unauthorized');
    // Basic CSRF protection for cookie auth: state-changing requests must come from our own origin.
    if (req.method !== 'GET' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw new HttpError(403, 'Cross-origin request rejected');
    for (const [method, re, handler] of routes) {
      if (method !== req.method) continue;
      const m = pathname.match(re);
      if (m) return await handler(req, res, m.map((x, i) => (i ? decodeURIComponent(x) : x)), url);
    }
    throw new HttpError(404, 'Not found');
  } catch (err) {
    const status = err.code === 'ENOENT' ? 404 : err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) send(res, status, { error: err.message });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  const s = getSettings();
  console.log(`\n  CodeAgent is running → http://localhost:${PORT}`);
  console.log(`  Access token: ${process.env.ACCESS_TOKEN ? '(from ACCESS_TOKEN env)' : ACCESS_TOKEN}`);
  console.log(`  LLM: ${s.llm.provider} / ${s.llm.model}${s.llm.apiKey || s.llm.provider === 'ollama' ? '' : '  (no API key yet — set it in Settings)'}`);
  console.log(`  GitHub: ${s.github.token ? 'token configured' : 'no token (Settings → GitHub)'}\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { shutdownMcp(); process.exit(0); });

export default server;
