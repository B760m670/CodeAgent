import { execFile } from 'node:child_process';
import { getSettings } from '../config.js';

const API = 'https://api.github.com';

export async function gh(method, endpoint, body, { token = getSettings().github.token, accept } = {}) {
  if (!token) throw new Error('GitHub token is not configured (Settings → GitHub token)');
  const res = await fetch(endpoint.startsWith('http') ? endpoint : API + endpoint, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'CodeAgent',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* diff / plain text */ }
  if (!res.ok) {
    const msg = typeof data === 'object' ? data.message + (data.errors ? ' ' + JSON.stringify(data.errors) : '') : text;
    const err = new Error(`GitHub ${method} ${endpoint} → ${res.status}: ${String(msg).slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * Environment that authenticates git over HTTPS to github.com without writing
 * the token into .git/config or remote URLs.
 */
export function gitAuthEnv(token = getSettings().github.token) {
  const s = getSettings().github;
  const env = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: s.gitUserName, GIT_AUTHOR_EMAIL: s.gitUserEmail,
    GIT_COMMITTER_NAME: s.gitUserName, GIT_COMMITTER_EMAIL: s.gitUserEmail,
  };
  if (!token) return env;
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    ...env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

export function git(args, cwd, { timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, ...gitAuthEnv() } }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(`git ${args.join(' ')} failed: ${(stderr || err.message).trim()}`);
        e.stdout = stdout; e.stderr = stderr;
        return reject(e);
      }
      resolve(stdout);
    });
  });
}

/** Parse owner/repo from the workspace's origin remote. */
export async function repoFromWorkspace(cwd) {
  const url = (await git(['remote', 'get-url', 'origin'], cwd).catch(() => '')).trim();
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export async function resolveRepo(args, cwd) {
  if (args.repo && args.repo.includes('/')) {
    const [owner, repo] = args.repo.split('/');
    return { owner, repo };
  }
  const r = await repoFromWorkspace(cwd);
  if (!r) throw new Error('Cannot determine GitHub repository: workspace has no github.com origin remote; pass repo="owner/name"');
  return r;
}
