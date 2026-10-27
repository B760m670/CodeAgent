#!/usr/bin/env node
/**
 * Headless mode, like `claude -p` / `codex exec`: run one task in a directory
 * and print the result. Useful for scripts, cron and GitHub Actions.
 *
 *   node server/cli.js "fix the failing test" --cwd ./repo --mode auto
 *   echo "explain src/" | node server/cli.js --mode plan --json
 */
import path from 'node:path';
import { Agent } from './agent/agent.js';
import { expandCommand } from './agent/commands.js';
import { getSettings } from './config.js';
import { MODES } from './tools/index.js';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i !== -1) argv.splice(i, 1);
  return i !== -1;
};

if (flag('help')) {
  console.log(`Usage: codeagent-cli "<task>" [--cwd DIR] [--mode plan|acceptEdits|auto] [--model NAME] [--max-turns N] [--json] [--quiet]
Reads the task from stdin when no task argument is given. Mode "ask" is not available headless (no one to approve).`);
  process.exit(0);
}

const cwd = path.resolve(opt('cwd', process.cwd()));
const mode = opt('mode', 'acceptEdits');
const model = opt('model');
const maxTurns = opt('max-turns');
const json = flag('json');
const quiet = flag('quiet');
if (!MODES.includes(mode) || mode === 'ask') {
  console.error(`--mode must be one of: plan, acceptEdits, auto`);
  process.exit(2);
}

let task = argv.join(' ').trim();
if (!task && !process.stdin.isTTY) {
  for await (const chunk of process.stdin) task += chunk;
  task = task.trim();
}
if (!task) { console.error('No task given. See --help'); process.exit(2); }
if (task.startsWith('/')) task = expandCommand(task, cwd)?.prompt || task;

const base = getSettings();
const settings = {
  ...base,
  llm: { ...base.llm, ...(model ? { model } : {}) },
  agent: { ...base.agent, ...(maxTurns ? { maxTurns: Number(maxTurns) } : {}) },
};
const session = { id: 'cli', messages: [], todos: [] };
const agent = new Agent({ session, cwd, settings, mode });
const err = (s) => { if (!quiet && !json) process.stderr.write(s); };

agent.on('text', ({ text }) => { if (!json) process.stdout.write(text); });
agent.on('assistant_message', ({ message }) => { if (!json && message.content) process.stdout.write('\n'); });
agent.on('tool_call', ({ name, summary, args }) => err(`\x1b[36m● ${name}\x1b[0m ${summary || JSON.stringify(args).slice(0, 160)}\n`));
agent.on('tool_result', ({ isError, content }) => err(isError ? `\x1b[31m  ✕ ${content.split('\n')[0].slice(0, 200)}\x1b[0m\n` : ''));
agent.on('error', ({ message }) => console.error(`\x1b[31mError: ${message}\x1b[0m`));
process.on('SIGINT', () => agent.stop());

try {
  const result = await agent.run(task);
  if (json) console.log(JSON.stringify({ result, usage: agent.usage, messages: session.messages.length }));
  process.exit(0);
} catch {
  process.exit(1);
}
