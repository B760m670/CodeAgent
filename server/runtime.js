import { Agent } from './agent/agent.js';
import { expandCommand } from './agent/commands.js';
import { MODES } from './tools/index.js';
import { getSettings } from './config.js';
import { getSession, saveSession } from './sessions.js';
import { workspacePath } from './workspaces.js';

/** Live state per session: the agent instance, SSE subscribers, and the event buffer of the current run. */
const live = new Map();

function entry(id) {
  let e = live.get(id);
  if (!e) { e = { agent: null, session: null, subscribers: new Set(), buffer: [] }; live.set(id, e); }
  return e;
}

function broadcast(id, type, data) {
  const e = entry(id);
  const evt = { type, ...data, ts: Date.now() };
  e.buffer.push(evt);
  if (e.buffer.length > 5000) e.buffer.splice(0, e.buffer.length - 5000);
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of e.subscribers) res.write(line);
}

export function subscribe(id, res) {
  const e = entry(id);
  e.subscribers.add(res);
  // Replay the in-progress run so a reloaded page catches up.
  if (e.agent?.running) for (const evt of e.buffer) res.write(`data: ${JSON.stringify(evt)}\n\n`);
  res.on('close', () => e.subscribers.delete(res));
}

export function status(id) {
  const e = live.get(id);
  return {
    running: !!e?.agent?.running,
    pending: e?.agent?.running ? e.buffer.filter((x) => x.type === 'permission_request' && !e.buffer.some((y) => y.type === 'permission_resolved' && y.requestId === x.requestId)) : [],
  };
}

function getAgent(id, session) {
  const e = entry(id);
  const settings = getSettings();
  if (!e.agent || e.session !== session) {
    e.agent = new Agent({ session, cwd: workspacePath(session.workspace), settings, mode: session.mode });
    e.session = session;
    const forward = ['text', 'assistant_message', 'tool_call', 'tool_progress', 'tool_result', 'permission_request', 'permission_resolved', 'todos', 'usage', 'compacted', 'error', 'hook'];
    for (const t of forward) e.agent.on(t, (data) => broadcast(id, t, data));
    e.agent.on('tool_result', (r) => {
      if (r.display || r.isError) session.displays[r.id] = { display: r.display, isError: r.isError };
      saveSession(session);
    });
    e.agent.on('assistant_message', () => saveSession(session));
  }
  e.agent.settings = settings; // pick up settings changes between runs
  e.agent.mode = session.mode;
  return e.agent;
}

/**
 * Handle a user message for a session: slash commands, then run the agent.
 * Resolves when the run finishes (callers may choose not to await).
 */
export async function sendMessage(id, text, { mode, systemExtra } = {}) {
  const e = entry(id);
  const session = e.session && e.session.id === id ? e.session : getSession(id);
  if (!session) throw new Error('Session not found');
  if (e.agent?.running) throw new Error('Agent is already running in this session');
  if (mode && MODES.includes(mode)) session.mode = mode;

  const cwd = workspacePath(session.workspace);
  const cmd = text.trim().startsWith('/') ? expandCommand(text.trim(), cwd) : null;
  if (cmd?.local) return runLocalCommand(id, session, cmd);

  const agent = getAgent(id, session);
  if (systemExtra !== undefined) agent.systemExtra = systemExtra;
  if (session.title === 'New session') session.title = text.trim().slice(0, 70);
  e.buffer = [];
  broadcast(id, 'run_start', { user: text, mode: session.mode });
  try {
    return await agent.run(cmd?.prompt || text);
  } catch {
    return null; // already broadcast as an 'error' event
  } finally {
    saveSession(session);
    broadcast(id, 'done', { usage: agent.usage });
  }
}

async function runLocalCommand(id, session, { local, args }) {
  const e = entry(id);
  if (local === 'clear') {
    session.messages = [];
    session.todos = [];
    session.displays = {};
    e.agent = null;
    broadcast(id, 'cleared', {});
  } else if (local === 'mode') {
    if (!MODES.includes(args)) { broadcast(id, 'error', { message: `Unknown mode "${args}". Use one of: ${MODES.join(', ')}` }); return; }
    session.mode = args;
    broadcast(id, 'mode', { mode: args });
  } else if (local === 'compact') {
    const agent = getAgent(id, session);
    broadcast(id, 'run_start', { user: '/compact', mode: session.mode });
    try {
      agent.abort = new AbortController();
      const done = await agent.compact(true);
      if (!done) broadcast(id, 'error', { message: 'Nothing to compact yet' });
    } catch (err) {
      broadcast(id, 'error', { message: err.message });
    }
    broadcast(id, 'done', {});
  }
  saveSession(session);
}

export function stop(id) {
  live.get(id)?.agent?.stop();
}

export function respondPermission(id, requestId, decision, feedback) {
  return !!live.get(id)?.agent?.resolvePermission(requestId, decision, feedback);
}

export function forget(id) {
  const e = live.get(id);
  e?.agent?.stop();
  live.delete(id);
}

/** Session object in use (live copy if loaded, else from disk). */
export function currentSession(id) {
  const e = live.get(id);
  return e?.session || getSession(id);
}
