/**
 * Minimal Model Context Protocol client (stdio transport, newline-delimited
 * JSON-RPC 2.0). Lets the agent use any MCP server — the same servers Claude
 * Code and Codex use (filesystem, databases, Slack, Jira, browsers, ...).
 */
import { spawn } from 'node:child_process';

class McpServer {
  constructor(name, { command, args = [], env = {}, cwd }) {
    this.name = name;
    this.proc = spawn(command, args, { env: { ...process.env, ...env }, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = new Map();
    this.nextId = 1;
    this.buf = '';
    this.stderr = '';
    this.proc.stdout.on('data', (d) => this.#onData(d));
    this.proc.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    this.proc.on('exit', (code) => {
      this.dead = true;
      for (const { reject } of this.pending.values()) reject(new Error(`MCP server "${name}" exited (${code}): ${this.stderr.slice(-500)}`));
      this.pending.clear();
    });
    this.proc.on('error', (e) => { this.dead = true; this.startError = e; });
  }

  #onData(d) {
    this.buf += d;
    let nl;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message || JSON.stringify(msg.error))) : resolve(msg.result);
      }
    }
  }

  request(method, params, timeoutMs = 60_000) {
    if (this.dead) return Promise.reject(this.startError || new Error(`MCP server "${this.name}" is not running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method, params) {
    if (!this.dead) this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async init() {
    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'codeagent', version: '0.1.0' },
    });
    this.notify('notifications/initialized', {});
    const { tools = [] } = await this.request('tools/list', {});
    this.tools = tools;
    return tools;
  }

  close() { try { this.proc.kill(); } catch { /* ignore */ } }
}

const servers = new Map(); // key: name+config json

/** Start (or reuse) configured MCP servers and return agent tool definitions. */
export async function loadMcpTools(mcpConfig = {}, cwd) {
  const tools = [];
  for (const [name, cfg] of Object.entries(mcpConfig)) {
    if (!cfg?.command || cfg.disabled) continue;
    const key = name + JSON.stringify(cfg);
    let server = servers.get(key);
    try {
      if (!server || server.dead) {
        server = new McpServer(name, { ...cfg, cwd });
        servers.set(key, server);
        await server.init();
      }
    } catch (e) {
      console.warn(`[mcp] ${name}: ${e.message}`);
      continue;
    }
    for (const t of server.tools || []) {
      tools.push({
        name: `mcp__${name}__${t.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
        kind: t.annotations?.readOnlyHint ? 'read' : 'network',
        description: `[MCP ${name}] ${t.description || t.name}`,
        parameters: t.inputSchema || { type: 'object', properties: {} },
        async run(args) {
          const r = await server.request('tools/call', { name: t.name, arguments: args });
          const text = (r.content || []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
          if (r.isError) throw new Error(text || 'MCP tool error');
          return text || JSON.stringify(r.structuredContent ?? r);
        },
      });
    }
  }
  return tools;
}

export function mcpStatus() {
  return [...servers.values()].map((s) => ({ name: s.name, running: !s.dead, tools: (s.tools || []).map((t) => t.name), stderr: s.dead ? s.stderr : '' }));
}

export function shutdownMcp() {
  for (const s of servers.values()) s.close();
}
