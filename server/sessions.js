import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SESSIONS_DIR } from './config.js';

const file = (id) => path.join(SESSIONS_DIR, `${id.replace(/[^\w-]/g, '')}.json`);

export function createSession({ workspace, mode, title, source = 'web' }) {
  const s = {
    id: crypto.randomUUID(),
    title: title || 'New session',
    workspace,
    mode,
    source,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    todos: [],
    allow: [],
    // UI-only info that is not part of the LLM conversation (tool displays, errors).
    displays: {},
  };
  saveSession(s);
  return s;
}

export function getSession(id) {
  try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { return null; }
}

export function saveSession(s) {
  s.updatedAt = Date.now();
  const tmp = file(s.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, file(s.id));
}

export function deleteSession(id) {
  fs.rmSync(file(id), { force: true });
}

export function listSessions(workspace) {
  const out = [];
  for (const f of fs.readdirSync(SESSIONS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
      if (workspace && s.workspace !== workspace) continue;
      out.push({ id: s.id, title: s.title, workspace: s.workspace, mode: s.mode, source: s.source, updatedAt: s.updatedAt, messages: s.messages.length });
    } catch { /* corrupted file */ }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}
