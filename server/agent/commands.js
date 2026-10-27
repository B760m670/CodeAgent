import fs from 'node:fs';
import path from 'node:path';

/**
 * Slash commands. Built-ins mirror Claude Code / Codex; custom commands are
 * markdown prompt files in .codeagent/commands/, .claude/commands/ or
 * .codex/prompts/ (filename = command name, $ARGUMENTS is substituted).
 */
export const BUILTIN_COMMANDS = {
  init: {
    description: 'Analyze the repository and create/update AGENTS.md with project instructions',
    prompt: `Analyze this codebase and create (or improve, if it exists) an AGENTS.md file in the repository root for future AI agent sessions. Include:
- Project overview and architecture (big picture that requires reading several files to understand)
- Exact commands to install, build, lint, run tests (including a single test) and run the app
- Code style and conventions actually used in this repo
- Important gotchas
Keep it concise (under ~150 lines), don't list every file, don't invent anything you didn't verify. If CLAUDE.md, .cursorrules or similar exist, incorporate their important parts.`,
  },
  review: {
    description: 'Review current changes (or a PR: /review 12) for bugs and quality issues',
    prompt: `Review the code changes $ARGUMENTS_OR_LOCAL. Look for: correctness bugs, edge cases, security issues, performance problems, missing tests, and style inconsistencies with the surrounding code. For each finding give file:line, severity (high/medium/low), what's wrong and a concrete fix. Verify each finding by reading the relevant code before reporting it; don't report speculative issues. Don't modify files.`,
  },
  commit: {
    description: 'Commit current changes with a good message',
    prompt: 'Look at git status and git diff, then create a commit with a concise message (imperative subject line under 72 chars, body explaining why if non-trivial). If we are on the default branch and the change is non-trivial, create a feature branch first. Don\'t commit secrets or unrelated files. $ARGUMENTS',
  },
  pr: {
    description: 'Create a branch, commit, push and open a pull request',
    prompt: 'Deliver the current work as a GitHub pull request: if on the default branch, create a descriptive feature branch; commit all relevant changes; push with git_push; then open a PR with github_create_pr whose body has "## Summary" (bullets) and "## Test plan". Report the PR URL. $ARGUMENTS',
  },
  test: {
    description: 'Run the project tests and fix failures',
    prompt: 'Find out how this project runs its tests, run them, and fix any failures caused by the code (not by the environment). Re-run until green, then summarize. $ARGUMENTS',
  },
  'fix-issue': {
    description: 'Fix a GitHub issue end-to-end: /fix-issue 42',
    prompt: 'Read GitHub issue #$ARGUMENTS with github_get_issue. Create a branch named like fix/issue-$ARGUMENTS, implement the fix with tests, run the tests, commit, push and open a PR that says "Fixes #$ARGUMENTS".',
  },
  explain: {
    description: 'Explain how the project or a part of it works',
    prompt: 'Explain how $ARGUMENTS works in this codebase: main components, data flow and key files (with path:line references). Use the task tool for broad exploration if needed. Don\'t modify files.',
  },
  compact: { description: 'Summarize the conversation to free context', local: true },
  clear: { description: 'Clear the conversation history', local: true },
  mode: { description: 'Switch permission mode: /mode plan|ask|acceptEdits|auto', local: true },
};

const DIRS = ['.codeagent/commands', '.claude/commands', '.codex/prompts'];

export function listCommands(cwd) {
  const cmds = Object.entries(BUILTIN_COMMANDS).map(([name, c]) => ({ name, description: c.description, builtin: true }));
  for (const dir of DIRS) {
    const abs = path.join(cwd, dir);
    let files = [];
    try { files = fs.readdirSync(abs).filter((f) => f.endsWith('.md')); } catch { continue; }
    for (const f of files) {
      const text = fs.readFileSync(path.join(abs, f), 'utf8');
      const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
      const desc = fm?.[1].match(/description:\s*(.+)/)?.[1] || text.replace(/^---[\s\S]*?---\n?/, '').split('\n').find(Boolean)?.slice(0, 80) || '';
      cmds.push({ name: f.slice(0, -3), description: desc.trim(), builtin: false, file: path.join(dir, f) });
    }
  }
  return cmds;
}

/** Expand "/name args" into a prompt. Returns null if text is not a known command. */
export function expandCommand(text, cwd) {
  const m = text.match(/^\/([\w:-]+)\s*([\s\S]*)$/);
  if (!m) return null;
  const [, name, args] = m;
  const builtin = BUILTIN_COMMANDS[name];
  if (builtin?.local) return { local: name, args: args.trim() };
  if (builtin) {
    const target = args.trim() ? (/^\d+$/.test(args.trim()) ? `in pull request #${args.trim()} (use github_get_pr with include_diff)` : `for: ${args.trim()}`) : 'in the working tree (git_diff against HEAD, and the branch vs the default branch if there are commits ahead)';
    return { prompt: builtin.prompt.replace(/\$ARGUMENTS_OR_LOCAL/g, target).replace(/\$ARGUMENTS/g, args.trim()).trim() };
  }
  for (const dir of DIRS) {
    const file = path.join(cwd, dir, `${name}.md`);
    if (fs.existsSync(file)) {
      const body = fs.readFileSync(file, 'utf8').replace(/^---[\s\S]*?---\n?/, '');
      const prompt = body.includes('$ARGUMENTS') ? body.replace(/\$ARGUMENTS/g, args.trim()) : `${body}\n\n${args}`;
      return { prompt: prompt.trim() };
    }
  }
  return null;
}
