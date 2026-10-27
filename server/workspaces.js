import fs from 'node:fs';
import path from 'node:path';
import { WORKSPACES_DIR } from './config.js';
import { git } from './github/api.js';
import { resolveInside, isProbablyBinary, IGNORED_DIRS } from './util/paths.js';

const NAME_RE = /^[\w.-]{1,100}$/;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function workspacePath(name) {
  if (!NAME_RE.test(name || '') || name.startsWith('.')) throw httpError(400, `Invalid workspace name: ${name}`);
  const p = path.join(WORKSPACES_DIR, name);
  if (!fs.existsSync(p)) throw httpError(404, `Workspace not found: ${name}`);
  return p;
}

export async function listWorkspaces() {
  const out = [];
  for (const e of fs.readdirSync(WORKSPACES_DIR, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const p = path.join(WORKSPACES_DIR, e.name);
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], p).then((s) => s.trim()).catch(() => null);
    const remote = await git(['remote', 'get-url', 'origin'], p).then((s) => s.trim()).catch(() => null);
    out.push({ name: e.name, branch, remote });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function createWorkspace({ name, cloneUrl, branch }) {
  if (!name && cloneUrl) name = cloneUrl.replace(/\.git$/, '').split(/[/:]/).pop();
  if (!NAME_RE.test(name || '') || name.startsWith('.')) throw httpError(400, 'Workspace name may contain letters, digits, ".", "_" and "-"');
  const dir = path.join(WORKSPACES_DIR, name);
  if (fs.existsSync(dir)) throw httpError(409, `Workspace "${name}" already exists`);
  if (cloneUrl) {
    if (!/^(https:\/\/|git@)/.test(cloneUrl)) throw httpError(400, 'Clone URL must start with https:// or git@');
    const args = ['clone', '--', cloneUrl, dir];
    if (branch) args.splice(1, 0, '--branch', branch);
    await git(args, WORKSPACES_DIR, { timeout: 600_000 });
  } else {
    fs.mkdirSync(dir, { recursive: true });
    await git(['init', '-b', 'main'], dir);
  }
  return { name };
}

export function deleteWorkspace(name) {
  fs.rmSync(workspacePath(name), { recursive: true, force: true });
}

export function listDir(ws, rel = '.') {
  const root = workspacePath(ws);
  const abs = resolveInside(root, rel);
  return fs.readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.name !== '.git')
    .map((e) => ({ name: e.name, path: path.relative(root, path.join(abs, e.name)), dir: e.isDirectory(), ignored: IGNORED_DIRS.has(e.name) }))
    .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
}

export function readFile(ws, rel) {
  const abs = resolveInside(workspacePath(ws), rel);
  const stat = fs.statSync(abs);
  if (stat.size > 2_000_000) return { path: rel, binary: true, size: stat.size, content: '(file too large to display)' };
  const buf = fs.readFileSync(abs);
  if (isProbablyBinary(buf)) return { path: rel, binary: true, size: stat.size, content: '(binary file)' };
  return { path: rel, binary: false, size: stat.size, content: buf.toString('utf8') };
}

export function writeFile(ws, rel, content) {
  const abs = resolveInside(workspacePath(ws), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

export async function gitInfo(ws) {
  const cwd = workspacePath(ws);
  const safe = (args) => git(args, cwd).catch(() => '');
  const [status, branches, log, remote] = await Promise.all([
    safe(['status', '--porcelain=v1', '--branch', '--untracked-files=all']),
    safe(['branch', '-a', '--no-color', '--format=%(refname:short)|%(HEAD)']),
    safe(['log', '--oneline', '--decorate', '-n30', '--no-color']),
    safe(['remote', 'get-url', 'origin']),
  ]);
  const lines = status.split('\n').filter(Boolean);
  const header = lines[0]?.startsWith('##') ? lines.shift().slice(3) : '';
  return {
    branch: header.split('...')[0].replace('No commits yet on ', ''),
    tracking: header,
    remote: remote.trim(),
    files: lines.map((l) => ({ status: l.slice(0, 2), path: l.slice(3) })),
    branches: branches.split('\n').filter(Boolean).map((l) => { const [name, head] = l.split('|'); return { name, current: head === '*' }; }),
    log: log.split('\n').filter(Boolean),
  };
}

export async function gitDiff(ws, file) {
  const cwd = workspacePath(ws);
  const args = ['diff', '--no-color', 'HEAD'];
  if (file) args.push('--', file);
  let diff = await git(args, cwd).catch(() => git(['diff', '--no-color', '--cached'], cwd).catch(() => ''));
  // Include untracked files as additions.
  const untracked = (await git(['ls-files', '--others', '--exclude-standard'], cwd).catch(() => '')).split('\n').filter(Boolean);
  for (const f of untracked) {
    if (file && f !== file) continue;
    diff += await git(['diff', '--no-color', '--no-index', '/dev/null', f], cwd).catch((e) => e.stdout || '');
  }
  return diff;
}

export async function gitAction(ws, { action, branch, message, from, file }) {
  const cwd = workspacePath(ws);
  switch (action) {
    case 'checkout': return git(['switch', branch], cwd);
    case 'create-branch': return git(['switch', '-c', branch, ...(from ? [from] : [])], cwd);
    case 'commit':
      await git(['add', '-A'], cwd);
      return git(['commit', '-m', message || 'Update'], cwd);
    case 'push': return git(['push', '-u', 'origin', branch || (await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim()], cwd, { timeout: 180_000 });
    case 'pull': return git(['pull', '--ff-only'], cwd, { timeout: 180_000 });
    case 'fetch': return git(['fetch', '--all', '--prune'], cwd, { timeout: 180_000 });
    case 'merge': return git(['merge', '--no-ff', '--no-edit', branch], cwd);
    case 'discard': return git(['checkout', '--', '.'], cwd);
    case 'discard-file': {
      // Reject one file's changes: restore it from HEAD, or delete it if it is new.
      const abs = resolveInside(cwd, file);
      const rel = path.relative(cwd, abs);
      const inHead = await git(['cat-file', '-e', `HEAD:${rel}`], cwd).then(() => true, () => false);
      if (inHead) return git(['checkout', 'HEAD', '--', rel], cwd);
      await git(['rm', '--cached', '-q', '--ignore-unmatch', '--', rel], cwd);
      fs.rmSync(abs, { force: true });
      return `Removed ${rel}`;
    }
    default: throw new Error(`Unknown git action ${action}`);
  }
}
