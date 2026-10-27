import { spawn } from 'node:child_process';
import { gitAuthEnv } from '../github/api.js';

const MAX_OUTPUT = 30_000;

function truncateMiddle(s, max = MAX_OUTPUT) {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return s.slice(0, half) + `\n\n… [${s.length - max} characters truncated] …\n\n` + s.slice(-half);
}

export function runShell(command, { cwd, timeoutSec = 120, signal, onOutput, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], {
      cwd,
      detached: true, // own process group so we can kill the whole tree
      env: { ...process.env, ...gitAuthEnv(), CI: '1', TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let killedReason = null;
    const onData = (d) => {
      const s = d.toString();
      if (out.length < MAX_OUTPUT * 4) out += s;
      onOutput?.(s);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const kill = (reason) => {
      killedReason = reason;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => kill(`timed out after ${timeoutSec}s`), timeoutSec * 1000);
    const onAbort = () => kill('aborted by user');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => { out += e.message; });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, output: truncateMiddle(out), killedReason });
    });
  });
}

export const bash = {
  name: 'bash',
  kind: 'exec',
  description: 'Run a shell command (bash) in the workspace root. Use for builds, tests, package managers, git, etc. Output (stdout+stderr) is returned, truncated if very long. Non-interactive only: pass flags like -y; do not start servers in the foreground (use `nohup cmd > log 2>&1 &`).',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to execute' },
      timeout: { type: 'integer', description: 'Timeout in seconds (default 120, max 600)' },
      description: { type: 'string', description: 'Short description of what the command does (5-10 words)' },
    },
    required: ['command'],
  },
  summary: (a) => a.command,
  async run({ command, timeout }, ctx) {
    const timeoutSec = Math.min(Math.max(Number(timeout) || ctx.settings.agent.bashTimeoutSec || 120, 1), 600);
    const { code, output, killedReason } = await runShell(command, {
      cwd: ctx.cwd, timeoutSec, signal: ctx.signal, onOutput: ctx.onProgress,
    });
    const status = killedReason ? `Command ${killedReason}` : `Exit code: ${code}`;
    return `${output.trimEnd() || '(no output)'}\n\n${status}`;
  },
};
