/**
 * GitHub App / repository webhook: mention the trigger phrase (default
 * "@codeagent") in an issue, issue comment or PR comment and the agent picks
 * the task up, works on a branch, pushes and opens a PR (like `@claude` in
 * Claude Code GitHub Actions or `@codex` in Codex cloud).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getSettings, WORKSPACES_DIR } from '../config.js';
import { gh, git } from './api.js';
import { createSession } from '../sessions.js';
import { sendMessage } from '../runtime.js';

const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export function verifySignature(secret, rawBody, signature) {
  if (!secret) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Decide whether an event is a task for us. Returns null or a task description. */
export function parseEvent(event, payload, trigger) {
  const has = (s) => typeof s === 'string' && s.toLowerCase().includes(trigger.toLowerCase());
  const repo = payload.repository;
  if (!repo) return null;
  if (event === 'issue_comment' && payload.action === 'created' && has(payload.comment.body)) {
    if (!TRUSTED.has(payload.comment.author_association)) return { ignored: 'untrusted commenter' };
    return {
      repo: repo.full_name,
      number: payload.issue.number,
      isPR: !!payload.issue.pull_request,
      title: payload.issue.title,
      body: payload.issue.body || '',
      request: payload.comment.body,
      author: payload.comment.user.login,
    };
  }
  if (event === 'issues' && ['opened', 'assigned'].includes(payload.action) && (has(payload.issue.body) || has(payload.issue.title))) {
    if (!TRUSTED.has(payload.issue.author_association)) return { ignored: 'untrusted author' };
    return { repo: repo.full_name, number: payload.issue.number, isPR: false, title: payload.issue.title, body: payload.issue.body || '', request: payload.issue.body || payload.issue.title, author: payload.issue.user.login };
  }
  if (event === 'pull_request_review_comment' && payload.action === 'created' && has(payload.comment.body)) {
    if (!TRUSTED.has(payload.comment.author_association)) return { ignored: 'untrusted commenter' };
    return {
      repo: repo.full_name, number: payload.pull_request.number, isPR: true, title: payload.pull_request.title,
      body: payload.pull_request.body || '', request: `${payload.comment.body}\n\n(on ${payload.comment.path}:${payload.comment.line ?? ''})\n${payload.comment.diff_hunk || ''}`,
      author: payload.comment.user.login,
    };
  }
  return null;
}

async function prepareWorkspace(task) {
  const [owner, name] = task.repo.split('/');
  const wsName = `${owner}__${name}`;
  const dir = path.join(WORKSPACES_DIR, wsName);
  if (!fs.existsSync(dir)) await git(['clone', '--', `https://github.com/${task.repo}.git`, dir], WORKSPACES_DIR, { timeout: 600_000 });
  await git(['fetch', 'origin', '--prune'], dir, { timeout: 300_000 });
  // Throw away leftovers from a previous run.
  await git(['reset', '--hard'], dir);
  await git(['clean', '-fd'], dir);
  let branch;
  if (task.isPR) {
    const pr = await gh('GET', `/repos/${task.repo}/pulls/${task.number}`);
    if (pr.head.repo?.full_name !== task.repo) throw new Error('PRs from forks are not supported');
    branch = pr.head.ref;
    await git(['switch', '-C', branch, `origin/${branch}`], dir);
  } else {
    const { default_branch } = await gh('GET', `/repos/${task.repo}`);
    branch = `codeagent/issue-${task.number}-${Date.now().toString(36)}`;
    await git(['switch', '-C', branch, `origin/${default_branch}`], dir);
  }
  return { wsName, branch };
}

export async function handleTask(task) {
  const settings = getSettings();
  const reaction = (content) => gh('POST', `/repos/${task.repo}/issues/${task.number}/comments`, { body: content }).catch((e) => console.warn('[webhook] comment failed:', e.message));
  try {
    const { wsName, branch } = await prepareWorkspace(task);
    await reaction(`👀 CodeAgent is working on this (branch \`${branch}\`).`);
    const session = createSession({ workspace: wsName, mode: 'auto', title: `GitHub #${task.number}: ${task.title}`.slice(0, 80), source: 'github' });
    const prompt = `You were mentioned on GitHub ${task.isPR ? 'pull request' : 'issue'} #${task.number} in ${task.repo} by @${task.author}.

Title: ${task.title}

Description:
${task.body.slice(0, 8000)}

Request:
${task.request.slice(0, 8000)}

You are on branch \`${branch}\`. Do the requested work. If it requires code changes: implement them, run the relevant tests, commit with git_commit and push with git_push. ${task.isPR ? 'This branch already has a PR, so pushing updates it.' : `Then open a pull request with github_create_pr (body must include "Closes #${task.number}" if it resolves the issue).`}
If the request is only a question, answer it without changing code. Your final message will be posted as a comment on GitHub, so make it a clear summary (markdown).`;
    const final = await sendMessage(session.id, prompt, { mode: 'auto' });
    await reaction(`${final || '⚠️ CodeAgent finished without a summary (the model may have failed). Check the session in the web UI.'}\n\n---\n_by CodeAgent (${settings.llm.model})_`);
  } catch (err) {
    console.error('[webhook] task failed:', err);
    await reaction(`⚠️ CodeAgent failed: ${err.message}`);
  }
}
