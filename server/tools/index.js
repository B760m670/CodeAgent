import * as fsTools from './fs.js';
import { bash } from './shell.js';
import * as gitTools from './git.js';
import * as githubTools from './github.js';
import { webFetch, todoWrite } from './misc.js';

export const BUILTIN_TOOLS = [
  fsTools.readFile, fsTools.listDir, fsTools.glob, fsTools.grep,
  fsTools.editFile, fsTools.multiEdit, fsTools.writeFile,
  bash,
  gitTools.gitStatus, gitTools.gitDiff, gitTools.gitLog, gitTools.gitBranch, gitTools.gitCommit,
  gitTools.gitMerge, gitTools.gitPull, gitTools.gitPush,
  githubTools.githubListIssues, githubTools.githubGetIssue, githubTools.githubCreateIssue, githubTools.githubComment,
  githubTools.githubListPRs, githubTools.githubGetPR, githubTools.githubCreatePR, githubTools.githubMergePR,
  githubTools.githubReviewPR, githubTools.githubCIStatus,
  webFetch, todoWrite,
];

/**
 * Permission modes (modelled after Claude Code / Codex approval policies):
 *  plan        – read-only: research and propose a plan, no changes
 *  ask         – reads are automatic, everything else asks for approval
 *  acceptEdits – file edits/local git are automatic; shell, network and remote ask
 *  auto        – everything runs without asking (use in isolated environments)
 */
export const MODES = ['plan', 'ask', 'acceptEdits', 'auto'];

const AUTO_KINDS = {
  plan: new Set(['read']),
  ask: new Set(['read']),
  acceptEdits: new Set(['read', 'edit']),
  auto: new Set(['read', 'edit', 'exec', 'network', 'remote']),
};

/** @returns {'allow' | 'ask' | 'deny'} plus reason */
export function checkPermission(tool, args, { mode, settings, sessionAllow }) {
  if (tool.kind === 'exec') {
    const cmd = String(args.command || '').trim();
    const denied = (settings.agent.deniedCommands || []).find((d) => d && cmd.includes(d));
    if (denied) return { decision: 'deny', reason: `Command matches deny rule "${denied}"` };
  }
  if (mode === 'plan' && tool.kind !== 'read') {
    return { decision: 'deny', reason: 'Plan mode is read-only. Describe the change in your plan instead of making it.' };
  }
  if (AUTO_KINDS[mode]?.has(tool.kind)) return { decision: 'allow' };
  if (sessionAllow?.has(tool.name)) return { decision: 'allow' };
  if (tool.kind === 'exec') {
    const cmd = String(args.command || '').trim();
    // Only simple commands (no chaining/redirection) may match an allow prefix.
    const simple = !/[;&|`$<>]/.test(cmd);
    const ok = simple && (settings.agent.allowedCommands || []).some((p) => cmd === p || cmd.startsWith(p + ' '));
    if (ok || sessionAllow?.has(`bash:${cmd}`)) return { decision: 'allow' };
  }
  return { decision: 'ask' };
}

export function toOpenAITools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}
