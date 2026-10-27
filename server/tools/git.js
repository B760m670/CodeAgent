import { git } from '../github/api.js';

const trunc = (s, n = 30_000) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} chars truncated)` : s);

export const gitStatus = {
  name: 'git_status',
  kind: 'read',
  description: 'Show current branch, tracking info and changed files (git status).',
  parameters: { type: 'object', properties: {} },
  async run(_, ctx) {
    return (await git(['status', '--short', '--branch'], ctx.cwd)).trim() || 'clean';
  },
};

export const gitDiff = {
  name: 'git_diff',
  kind: 'read',
  description: 'Show a diff. By default unstaged+staged changes vs HEAD. Use `ref` to compare against a branch/commit (e.g. "main" or "main...HEAD").',
  parameters: {
    type: 'object',
    properties: {
      ref: { type: 'string', description: 'Ref or range to diff against (default HEAD)' },
      path: { type: 'string', description: 'Limit to a path' },
      stat: { type: 'boolean', description: 'Only show diffstat' },
    },
  },
  async run({ ref = 'HEAD', path, stat }, ctx) {
    const args = ['diff', '--no-color'];
    if (stat) args.push('--stat');
    args.push(ref);
    if (path) args.push('--', path);
    const out = await git(args, ctx.cwd).catch(async (e) => {
      // Fresh repo without commits: fall back to cached diff.
      if (ref === 'HEAD') return git(['diff', '--no-color', '--cached'], ctx.cwd);
      throw e;
    });
    return trunc(out) || 'No differences';
  },
};

export const gitLog = {
  name: 'git_log',
  kind: 'read',
  description: 'Show recent commits (one line each).',
  parameters: { type: 'object', properties: { count: { type: 'integer' }, ref: { type: 'string' } } },
  async run({ count = 20, ref }, ctx) {
    const args = ['log', '--oneline', '--decorate', `-n${Math.min(count, 200)}`];
    if (ref) args.push(ref);
    return (await git(args, ctx.cwd).catch(() => '')).trim() || 'No commits yet';
  },
};

export const gitBranch = {
  name: 'git_branch',
  kind: 'edit',
  description: 'Create and/or switch branches. action: "list" | "create" (new branch from `from` or current HEAD, and switch to it) | "switch".',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'create', 'switch'] },
      name: { type: 'string', description: 'Branch name' },
      from: { type: 'string', description: 'Start point for create (default current HEAD)' },
    },
    required: ['action'],
  },
  summary: (a) => `${a.action} ${a.name || ''}`.trim(),
  async run({ action, name, from }, ctx) {
    if (action === 'list') return (await git(['branch', '-a', '-vv', '--no-color'], ctx.cwd)).trim();
    if (!name) throw new Error('name is required');
    if (action === 'create') {
      await git(['switch', '-c', name, ...(from ? [from] : [])], ctx.cwd);
      return `Created and switched to branch ${name}`;
    }
    await git(['switch', name], ctx.cwd);
    return `Switched to branch ${name}`;
  },
};

export const gitCommit = {
  name: 'git_commit',
  kind: 'edit',
  description: 'Stage changes and create a commit. By default stages all changes (git add -A). Write a concise message explaining why.',
  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string' },
      paths: { type: 'array', items: { type: 'string' }, description: 'Only stage these paths (default: all)' },
    },
    required: ['message'],
  },
  summary: (a) => a.message?.split('\n')[0],
  async run({ message, paths }, ctx) {
    await git(['add', ...(paths?.length ? ['--', ...paths] : ['-A'])], ctx.cwd);
    const staged = (await git(['diff', '--cached', '--name-only'], ctx.cwd)).trim();
    if (!staged) return 'Nothing to commit';
    await git(['commit', '-m', message], ctx.cwd);
    return (await git(['log', '--oneline', '-n1', '--stat'], ctx.cwd)).trim();
  },
};

export const gitPush = {
  name: 'git_push',
  kind: 'remote',
  description: 'Push the current (or given) branch to origin and set upstream. Never force-pushes.',
  parameters: { type: 'object', properties: { branch: { type: 'string' } } },
  summary: (a) => a.branch || 'current branch',
  async run({ branch }, ctx) {
    const b = branch || (await git(['rev-parse', '--abbrev-ref', 'HEAD'], ctx.cwd)).trim();
    const out = await git(['push', '-u', 'origin', b], ctx.cwd, { timeout: 180_000 });
    return `Pushed ${b} to origin. ${out.trim()}`;
  },
};

export const gitPull = {
  name: 'git_pull',
  kind: 'remote',
  description: 'Fetch and fast-forward the current branch from origin (git pull --ff-only).',
  parameters: { type: 'object', properties: {} },
  async run(_, ctx) {
    return (await git(['pull', '--ff-only'], ctx.cwd, { timeout: 180_000 })).trim() || 'Up to date';
  },
};

export const gitMerge = {
  name: 'git_merge',
  kind: 'edit',
  description: 'Merge a branch into the current branch locally (no fast-forward commit). Reports conflicts if any.',
  parameters: { type: 'object', properties: { branch: { type: 'string' } }, required: ['branch'] },
  summary: (a) => a.branch,
  async run({ branch }, ctx) {
    try {
      return (await git(['merge', '--no-ff', '--no-edit', branch], ctx.cwd)).trim();
    } catch (e) {
      const conflicts = (await git(['diff', '--name-only', '--diff-filter=U'], ctx.cwd).catch(() => '')).trim();
      if (conflicts) return `Merge has conflicts in:\n${conflicts}\nResolve them (edit files, remove markers), then git_commit. Or run \`git merge --abort\`.`;
      throw e;
    }
  },
};
