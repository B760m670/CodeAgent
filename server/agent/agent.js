import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { chat, parseArgs } from '../llm/provider.js';
import { BUILTIN_TOOLS, checkPermission, toOpenAITools } from '../tools/index.js';
import { buildSystemPrompt } from './prompt.js';
import { runHooks } from '../hooks.js';
import { loadMcpTools } from '../mcp/client.js';
import { git } from '../github/api.js';

const MAX_TOOL_RESULT = 40_000;
const estimateTokens = (x) => Math.ceil(JSON.stringify(x).length / 3.5);

/**
 * The agentic loop: send the conversation to the model, execute the tool calls
 * it asks for (subject to permissions and hooks), feed results back, repeat
 * until the model answers without tool calls.
 *
 * Events: text, assistant_message, tool_call, tool_progress, tool_result,
 * permission_request, permission_resolved, todos, usage, compacted, error, done.
 */
export class Agent extends EventEmitter {
  constructor({ session, cwd, settings, mode, llm = chat, subagent = false, systemExtra = '' }) {
    super();
    this.session = session;
    this.cwd = cwd;
    this.settings = settings;
    this.mode = mode || settings.agent.defaultMode;
    this.llm = llm;
    this.subagent = subagent;
    this.systemExtra = systemExtra;
    this.pending = new Map(); // permission requests
    this.sessionAllow = new Set(session.allow || []);
    this.readFiles = new Set();
    this.running = false;
    this.usage = { prompt_tokens: 0, completion_tokens: 0 };
  }

  async tools() {
    let tools = [...BUILTIN_TOOLS];
    if (this.subagent) return tools.filter((t) => t.kind === 'read' && t.name !== 'todo_write');
    tools.push(taskTool(this));
    if (Object.keys(this.settings.mcpServers || {}).length) {
      tools.push(...await loadMcpTools(this.settings.mcpServers, this.cwd));
    }
    return tools;
  }

  stop() {
    this.abort?.abort();
    for (const { reject } of this.pending.values()) reject(new Error('Aborted'));
    this.pending.clear();
  }

  resolvePermission(requestId, decision, feedback) {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    p.resolve({ decision, feedback });
    return true;
  }

  /** Run one user turn to completion. Returns the final assistant text. */
  async run(userContent) {
    if (this.running) throw new Error('Agent is already running');
    this.running = true;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const msgs = () => this.session.messages;
    let finalText = '';
    try {
      msgs().push({ role: 'user', content: userContent });
      const tools = await this.tools();
      const toolMap = new Map(tools.map((t) => [t.name, t]));
      const maxTurns = this.settings.agent.maxTurns || 60;
      for (let turn = 0; turn < maxTurns; turn++) {
        if (signal.aborted) break;
        await this.compact();
        const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], this.cwd).then((s) => s.trim()).catch(() => '');
        const system = buildSystemPrompt({ cwd: this.cwd, mode: this.mode, branch, subagent: this.subagent, extra: this.systemExtra });
        const res = await this.llm(this.settings.llm, {
          messages: [{ role: 'system', content: system }, ...msgs()],
          tools: toOpenAITools(tools),
          signal,
          onText: (text) => this.emit('text', { text }),
        });
        if (res.usage) {
          this.usage.prompt_tokens += res.usage.prompt_tokens || 0;
          this.usage.completion_tokens += res.usage.completion_tokens || 0;
          this.emit('usage', { ...this.usage, model: res.model });
        }
        const message = { role: 'assistant', content: res.content || (res.tool_calls.length ? null : '') };
        if (res.tool_calls.length) message.tool_calls = res.tool_calls;
        msgs().push(message);
        this.emit('assistant_message', { message, model: res.model });
        if (res.content) finalText = res.content;
        if (!res.tool_calls.length) break;

        for (const call of res.tool_calls) {
          if (signal.aborted) break;
          const result = await this.executeTool(call, toolMap, signal);
          msgs().push({ role: 'tool', tool_call_id: call.id, content: result.content });
          this.emit('tool_result', { id: call.id, name: call.function.name, ...result });
        }
        if (turn === maxTurns - 1) this.emit('error', { message: `Stopped after ${maxTurns} turns (agent.maxTurns)` });
      }
      if (!signal.aborted && !this.subagent) {
        const hook = await runHooks(this.settings.hooks, 'Stop', { session: this.session.id }, this.cwd);
        for (const r of hook.results) this.emit('hook', { event: 'Stop', ...r });
      }
    } catch (err) {
      if (!signal.aborted) {
        this.emit('error', { message: err.message });
        throw err;
      }
    } finally {
      this.closeDanglingToolCalls();
      this.session.allow = [...this.sessionAllow];
      this.running = false;
      this.emit('done', { aborted: signal.aborted, usage: this.usage });
    }
    return finalText;
  }

  /** Every assistant tool call must be followed by a tool result, or the next request fails. */
  closeDanglingToolCalls() {
    const m = this.session.messages;
    for (let i = m.length - 1; i >= 0; i--) {
      if (m[i].role === 'assistant' && m[i].tool_calls) {
        const answered = new Set(m.slice(i + 1).filter((x) => x.role === 'tool').map((x) => x.tool_call_id));
        for (const c of m[i].tool_calls) {
          if (!answered.has(c.id)) m.push({ role: 'tool', tool_call_id: c.id, content: 'Interrupted by user before this tool ran.' });
        }
        break;
      }
      if (m[i].role === 'user') break;
    }
  }

  async executeTool(call, toolMap, signal) {
    const name = call.function.name;
    const tool = toolMap.get(name);
    let args;
    try { args = parseArgs(call.function.arguments); } catch {
      return this.#error(`Invalid JSON in arguments for ${name}. Send valid JSON matching the schema.`);
    }
    this.emit('tool_call', { id: call.id, name, args, kind: tool?.kind, summary: tool?.summary?.(args) ?? null });
    if (!tool) return this.#error(`Unknown tool "${name}". Available: ${[...toolMap.keys()].join(', ')}`);

    const perm = checkPermission(tool, args, { mode: this.mode, settings: this.settings, sessionAllow: this.sessionAllow });
    if (perm.decision === 'deny') return this.#error(`Permission denied: ${perm.reason}`);
    if (perm.decision === 'ask') {
      if (this.subagent) return this.#error('Sub-agents cannot request permissions');
      const requestId = crypto.randomUUID();
      this.emit('permission_request', { requestId, id: call.id, name, kind: tool.kind, args, summary: tool.summary?.(args) ?? null });
      let answer;
      try {
        answer = await new Promise((resolve, reject) => this.pending.set(requestId, { resolve, reject }));
      } catch {
        return this.#error('Interrupted by user');
      }
      this.emit('permission_resolved', { requestId, decision: answer.decision });
      if (answer.decision === 'deny') {
        return this.#error(`The user denied this ${name} call.${answer.feedback ? ` User feedback: ${answer.feedback}` : ' Ask the user how to proceed or try a different approach.'}`);
      }
      if (answer.decision === 'always') this.sessionAllow.add(name);
    }

    const pre = await runHooks(this.settings.hooks, 'PreToolUse', { tool: name, args }, this.cwd);
    if (pre.blocked) return this.#error(`Blocked by PreToolUse hook: ${pre.reason}`);

    const ctx = {
      cwd: this.cwd,
      settings: this.settings,
      signal,
      session: this.session,
      readFiles: this.readFiles,
      permissionMode: this.mode,
      emit: (type, data) => this.emit(type, data),
      onProgress: (chunk) => this.emit('tool_progress', { id: call.id, chunk }),
    };
    let result;
    try {
      const out = await tool.run(args, ctx);
      result = typeof out === 'string' ? { content: out } : out;
    } catch (err) {
      return this.#error(`Error: ${err.message}`);
    }
    const post = await runHooks(this.settings.hooks, 'PostToolUse', { tool: name, args, result: result.content }, this.cwd);
    const failed = post.results.filter((r) => r.code !== 0);
    if (failed.length) result.content += '\n\nPostToolUse hook output:\n' + failed.map((r) => r.stderr || r.stdout).join('\n');
    if (result.content.length > MAX_TOOL_RESULT) {
      result.content = result.content.slice(0, MAX_TOOL_RESULT) + `\n… (truncated ${result.content.length - MAX_TOOL_RESULT} chars)`;
    }
    return { ...result, isError: false };
  }

  #error(content) { return { content, isError: true }; }

  /**
   * Context compaction (like Claude Code's /compact): when the conversation gets
   * close to the model's context window, summarize older messages.
   */
  async compact(force = false) {
    const limit = this.settings.llm.contextWindow || 64000;
    const m = this.session.messages;
    if (!force && estimateTokens(m) < limit * 0.75) return false;
    let keepFrom = m.length;
    let tail = 0;
    for (let i = m.length - 1; i > 0; i--) {
      tail += estimateTokens(m[i]);
      if (tail > limit * 0.25) break;
      if (m[i].role !== 'tool') keepFrom = i;
    }
    if (keepFrom >= m.length) keepFrom = m.length - 1;
    while (keepFrom > 0 && m[keepFrom].role === 'tool') keepFrom--;
    if (keepFrom <= 0) return false;

    const transcript = m.slice(0, keepFrom).map((x) => {
      if (x.role === 'tool') return `[tool result] ${String(x.content).slice(0, 1500)}`;
      const calls = (x.tool_calls || []).map((c) => `[call ${c.function.name} ${c.function.arguments.slice(0, 300)}]`).join(' ');
      return `[${x.role}] ${x.content || ''} ${calls}`;
    }).join('\n').slice(-limit * 2);

    const res = await this.llm(this.settings.llm, {
      messages: [
        { role: 'system', content: 'You summarize a coding-agent conversation so work can continue in a fresh context. Keep: the user\'s goals and constraints, decisions made, files read/changed (paths), commands run and their outcomes, errors, current state and the remaining next steps. Be dense and factual.' },
        { role: 'user', content: transcript },
      ],
      signal: this.abort?.signal,
      maxTokens: 2000,
    });
    const rest = m.slice(keepFrom);
    const head = [{ role: 'user', content: `[Summary of the earlier conversation, auto-compacted]\n${res.content}` }];
    if (rest[0]?.role !== 'assistant') head.push({ role: 'assistant', content: 'Understood. Continuing from the summary.' });
    this.session.messages = [...head, ...rest];
    this.emit('compacted', { removed: keepFrom, summary: res.content });
    return true;
  }
}

/** Sub-agent tool: isolated context, read-only tools, returns only its final report. */
function taskTool(parent) {
  return {
    name: 'task',
    kind: 'read',
    description: 'Launch a sub-agent with its own context and read-only tools (read/search/git/GitHub read) to research a question across the codebase. It returns only its final report, keeping your context small. Give it a complete, self-contained prompt.',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Short (3-5 words) task label' },
        prompt: { type: 'string', description: 'Detailed task for the sub-agent' },
      },
      required: ['prompt'],
    },
    summary: (a) => a.description || a.prompt.slice(0, 60),
    async run({ prompt }, ctx) {
      const sub = new Agent({
        session: { id: `${parent.session.id}:sub`, messages: [], todos: [] },
        cwd: parent.cwd,
        settings: { ...parent.settings, agent: { ...parent.settings.agent, maxTurns: 30 } },
        mode: 'plan',
        llm: parent.llm,
        subagent: true,
        systemExtra: 'You are a SUB-AGENT spawned by the main agent. Investigate the task with read-only tools, then reply with a concise, factual report (relevant file paths with line numbers, findings, answers). Do not write a plan for code changes unless asked.',
      });
      sub.on('tool_call', (e) => ctx.onProgress(`→ ${e.name} ${e.summary || JSON.stringify(e.args).slice(0, 120)}\n`));
      const abort = () => sub.stop();
      ctx.signal?.addEventListener('abort', abort, { once: true });
      try {
        return (await sub.run(prompt)) || '(sub-agent returned no text)';
      } finally {
        ctx.signal?.removeEventListener('abort', abort);
      }
    },
  };
}
