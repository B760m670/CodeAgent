/**
 * Lifecycle hooks, compatible in spirit with Claude Code hooks:
 *   settings.hooks = {
 *     PreToolUse:  [{ matcher: "bash|write_file", command: "./check.sh" }],
 *     PostToolUse: [{ matcher: "edit_file|write_file", command: "npx prettier --write \"$FILE\"" }],
 *     Stop:        [{ command: "npm test" }],
 *   }
 * The hook receives the event as JSON on stdin. For PreToolUse, exit code 2
 * blocks the tool call and stderr is shown to the model as the reason.
 */
import { spawn } from 'node:child_process';

function matches(matcher, toolName) {
  if (!matcher || matcher === '*') return true;
  try { return new RegExp(`^(?:${matcher})$`).test(toolName); } catch { return matcher === toolName; }
}

function runHook(command, payload, cwd) {
  return new Promise((resolve) => {
    const p = spawn('bash', ['-c', command], {
      cwd,
      env: { ...process.env, CODEAGENT_EVENT: payload.event, TOOL_NAME: payload.tool || '', FILE: payload.args?.path || '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), 60_000);
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('error', (e) => { stderr += e.message; });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }); });
    p.stdin.end(JSON.stringify(payload));
  });
}

export async function runHooks(hooks, event, payload, cwd) {
  const list = (hooks?.[event] || []).filter((h) => h.command && matches(h.matcher, payload.tool || ''));
  const results = [];
  for (const h of list) {
    const r = await runHook(h.command, { event, ...payload }, cwd);
    results.push({ command: h.command, ...r });
    if (event === 'PreToolUse' && r.code === 2) return { blocked: true, reason: r.stderr || r.stdout || 'Blocked by hook', results };
  }
  return { blocked: false, results };
}
