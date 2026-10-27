import { gh, resolveRepo, git } from '../github/api.js';

const repoParam = { repo: { type: 'string', description: 'owner/name (default: origin of the workspace)' } };
const short = (s, n = 4000) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');

export const githubListIssues = {
  name: 'github_list_issues',
  kind: 'read',
  description: 'List issues of the GitHub repository.',
  parameters: { type: 'object', properties: { ...repoParam, state: { type: 'string', enum: ['open', 'closed', 'all'] }, labels: { type: 'string' } } },
  async run(a, ctx) {
    const { owner, repo } = await resolveRepo(a, ctx.cwd);
    const q = new URLSearchParams({ state: a.state || 'open', per_page: '30' });
    if (a.labels) q.set('labels', a.labels);
    const items = await gh('GET', `/repos/${owner}/${repo}/issues?${q}`);
    return items.filter((i) => !i.pull_request).map((i) => `#${i.number} [${i.state}] ${i.title} (${i.user.login})`).join('\n') || 'No issues';
  },
};

export const githubGetIssue = {
  name: 'github_get_issue',
  kind: 'read',
  description: 'Read an issue or pull request with its comments.',
  parameters: { type: 'object', properties: { ...repoParam, number: { type: 'integer' } }, required: ['number'] },
  async run(a, ctx) {
    const { owner, repo } = await resolveRepo(a, ctx.cwd);
    const issue = await gh('GET', `/repos/${owner}/${repo}/issues/${a.number}`);
    const comments = await gh('GET', `/repos/${owner}/${repo}/issues/${a.number}/comments?per_page=50`);
    return [
      `#${issue.number} ${issue.title} [${issue.state}] by ${issue.user.login}`,
      short(issue.body),
      ...comments.map((c) => `--- ${c.user.login}:\n${short(c.body, 2000)}`),
    ].join('\n\n');
  },
};

export const githubCreateIssue = {
  name: 'github_create_issue',
  kind: 'remote',
  description: 'Create a GitHub issue.',
  parameters: { type: 'object', properties: { ...repoParam, title: { type: 'string' }, body: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } } }, required: ['title'] },
  summary: (a) => a.title,
  async run(a, ctx) {
    const { owner, repo } = await resolveRepo(a, ctx.cwd);
    const i = await gh('POST', `/repos/${owner}/${repo}/issues`, { title: a.title, body: a.body || '', labels: a.labels });
    return `Created issue #${i.number}: ${i.html_url}`;
  },
};

export const githubComment = {
  name: 'github_comment',
  kind: 'remote',
  description: 'Post a comment on an issue or pull request.',
  parameters: { type: 'object', properties: { ...repoParam, number: { type: 'integer' }, body: { type: 'string' } }, required: ['number', 'body'] },
  summary: (a) => `#${a.number}`,
  async run(a, ctx) {
    const { owner, repo } = await resolveRepo(a, ctx.cwd);
    const c = await gh('POST', `/repos/${owner}/${repo}/issues/${a.number}/comments`, { body: a.body });
    return `Commented: ${c.html_url}`;
  },
};

export const githubListPRs = {
  name: 'github_list_prs',
  kind: 'read',
  description: 'List pull requests.',
  parameters: { type: 'object', properties: { ...repoParam, state: { type: 'string', enum: ['open', 'closed', 'all'] } } },
  async run(a, ctx) {
    const { owner, repo } = await resolveRepo(a, ctx.cwd);
    const prs = await gh('GET', `/repos/${owner}/${repo}/pulls?state=${a.state || 'open'}&per_page=30`);
    return prs.map((p) => `#${p.number} [${p.state}${p.draft ? ', draft' : ''}] ${p.title} (${p.head.ref} → ${p.base.ref})`).join('\n') || 'No pull requests';
  },
};

export const githubGetPR = {
  name: 'github_get_pr',
  kind: 'read',
  description: 'Get a pull request: description, status, changed files and (optionally) the full diff.',
  parameters: { type: 'object', properties: { ...repoParam, number: { type: 'integer' }, include_diff: { type: 'boolean' } }, required: ['number'] },
  async run(a, ctx) {
    const { owner, repo } = await resolveRepo(a, ctx.cwd);
    const pr = await gh('GET', `/repos/${owner}/${repo}/pulls/${a.number}`);
    const files = await gh('GET', `/repos/${owner}/${repo}/pulls/${a.number}/files?per_page=100`);
    let out = `#${pr.number} ${pr.title} [${pr.state}${pr.merged ? ', merged' : ''}] ${pr.head.ref} → ${pr.base.ref}\nmergeable: ${pr.mergeable} (${pr.mergeable_state})\n\n${short(pr.body)}\n\nFiles:\n` +
      files.map((f) => `${f.status} ${f.filename} (+${f.additions} -${f.deletions})`).join('\n');
    if (a.include_diff) {
      const diff = await gh('GET', `/repos/${owner}/${repo}/pulls/${a.number}`, null, { accept: 'application/vnd.github.diff' });
      out += '\n\n' + short(diff, 30_000);
    }
    return out;
  },
};

export const githubCreatePR = {
  name: 'github_create_pr',
  kind: 'remote',
  description: 'Open a pull request from a pushed branch (default: current branch) into base (default: repo default branch). Push the branch first with git_push.',
  parameters: {
    type: 'object',
    properties: {
      ...repoParam,
      title: { type: 'string' },
      body: { type: 'string' },
      head: { type: 'string', description: 'Source branch (default current)' },
      base: { type: 'string', description: 'Target branch (default repo default branch)' },
      draft: { type: 'boolean' },
    },
    required: ['title'],
  },
  summary: (a) => a.title,
  async run(a, ctx) {
    const { owner, repo } = await resolveRepo(a, ctx.cwd);
    const head = a.head || (await git(['rev-parse', '--abbrev-ref', 'HEAD'], ctx.cwd)).trim();
    const base = a.base || (await gh('GET', `/repos/${owner}/${repo}`)).default_branch;
    const pr = await gh('POST', `/repos/${owner}/${repo}/pulls`, { title: a.title, body: a.body || '', head, base, draft: !!a.draft });
    return `Created PR #${pr.number}: ${pr.html_url}`;
  },
};

export const githubMergePR = {
  name: 'github_merge_pr',
  kind: 'remote',
  description: 'Merge a pull request on GitHub (method: merge | squash | rebase).',
  parameters: { type: 'object', properties: { ...repoParam, number: { type: 'integer' }, method: { type: 'string', enum: ['merge', 'squash', 'rebase'] }, commit_title: { type: 'string' } }, required: ['number'] },
  summary: (a) => `#${a.number} (${a.method || 'squash'})`,
  async run(a, ctx) {
    const { owner, repo } = await resolveRepo(a, ctx.cwd);
    const r = await gh('PUT', `/repos/${owner}/${repo}/pulls/${a.number}/merge`, { merge_method: a.method || 'squash', commit_title: a.commit_title });
    return `Merged PR #${a.number}: ${r.sha} ${r.message}`;
  },
};

export const githubReviewPR = {
  name: 'github_review_pr',
  kind: 'remote',
  description: 'Submit a review on a pull request (event: COMMENT | APPROVE | REQUEST_CHANGES) with optional inline comments.',
  parameters: {
    type: 'object',
    properties: {
      ...repoParam,
      number: { type: 'integer' },
      body: { type: 'string' },
      event: { type: 'string', enum: ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'] },
      comments: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, line: { type: 'integer' }, body: { type: 'string' } }, required: ['path', 'line', 'body'] } },
    },
    required: ['number', 'body'],
  },
  summary: (a) => `#${a.number} ${a.event || 'COMMENT'}`,
  async run(a, ctx) {
    const { owner, repo } = await resolveRepo(a, ctx.cwd);
    const r = await gh('POST', `/repos/${owner}/${repo}/pulls/${a.number}/reviews`, {
      body: a.body, event: a.event || 'COMMENT', comments: (a.comments || []).map((c) => ({ ...c, side: 'RIGHT' })),
    });
    return `Review submitted: ${r.html_url}`;
  },
};

export const githubCIStatus = {
  name: 'github_ci_status',
  kind: 'read',
  description: 'Show CI check runs for a ref (branch, SHA or "pr:<number>").',
  parameters: { type: 'object', properties: { ...repoParam, ref: { type: 'string' } } },
  async run(a, ctx) {
    const { owner, repo } = await resolveRepo(a, ctx.cwd);
    let ref = a.ref || (await git(['rev-parse', 'HEAD'], ctx.cwd)).trim();
    if (ref.startsWith('pr:')) ref = (await gh('GET', `/repos/${owner}/${repo}/pulls/${ref.slice(3)}`)).head.sha;
    const r = await gh('GET', `/repos/${owner}/${repo}/commits/${ref}/check-runs?per_page=50`);
    return r.check_runs.map((c) => `${c.name}: ${c.status}${c.conclusion ? ' / ' + c.conclusion : ''} ${c.html_url}`).join('\n') || 'No check runs';
  },
};
