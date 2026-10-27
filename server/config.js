import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load .env (real environment variables take precedence).
const envFile = path.join(ROOT_DIR, '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT_DIR, 'data'));
export const WORKSPACES_DIR = path.resolve(process.env.WORKSPACES_DIR || path.join(DATA_DIR, 'workspaces'));
export const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

for (const d of [DATA_DIR, WORKSPACES_DIR, SESSIONS_DIR]) fs.mkdirSync(d, { recursive: true });

/**
 * Free (or free-tier) OpenAI-compatible providers. All of them speak the
 * /chat/completions protocol with tool calling, so one client covers them all.
 */
export const PROVIDER_PRESETS = {
  openrouter: {
    label: 'OpenRouter (free models)',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openrouter/free',
    models: ['openrouter/free', 'qwen/qwen3-coder:free', 'deepseek/deepseek-chat-v3-0324:free', 'meta-llama/llama-3.3-70b-instruct:free'],
    keyUrl: 'https://openrouter.ai/keys',
  },
  groq: {
    label: 'Groq (free tier)',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'openai/gpt-oss-120b',
    models: ['openai/gpt-oss-120b', 'moonshotai/kimi-k2-instruct', 'llama-3.3-70b-versatile', 'qwen/qwen3-32b'],
    keyUrl: 'https://console.groq.com/keys',
  },
  gemini: {
    label: 'Google Gemini (free tier)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'],
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  cerebras: {
    label: 'Cerebras (free tier)',
    baseUrl: 'https://api.cerebras.ai/v1',
    model: 'gpt-oss-120b',
    models: ['gpt-oss-120b', 'qwen-3-coder-480b', 'llama-3.3-70b'],
    keyUrl: 'https://cloud.cerebras.ai',
  },
  mistral: {
    label: 'Mistral (free "Experiment" plan)',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'devstral-small-latest',
    models: ['devstral-small-latest', 'codestral-latest', 'mistral-small-latest'],
    keyUrl: 'https://console.mistral.ai/api-keys',
  },
  ollama: {
    label: 'Ollama (local, fully free)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5-coder:14b',
    models: ['qwen2.5-coder:14b', 'qwen3:14b', 'llama3.1:8b', 'devstral'],
    keyUrl: 'https://ollama.com/download',
  },
  custom: { label: 'Custom OpenAI-compatible', baseUrl: '', model: '', models: [] },
};

const env = process.env;

function defaults() {
  const provider = env.LLM_PROVIDER || 'openrouter';
  const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom;
  return {
    llm: {
      provider,
      baseUrl: env.LLM_BASE_URL || preset.baseUrl,
      apiKey: env.LLM_API_KEY || '',
      model: env.LLM_MODEL || preset.model,
      // Tried in order when the main model is rate-limited (429) or overloaded.
      fallbackModels: (env.LLM_FALLBACK_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean),
      temperature: 0.2,
      maxTokens: 8192,
      contextWindow: Number(env.LLM_CONTEXT_WINDOW || 64000),
    },
    github: {
      token: env.GITHUB_TOKEN || '',
      webhookSecret: env.GITHUB_WEBHOOK_SECRET || '',
      triggerPhrase: env.GITHUB_TRIGGER_PHRASE || '@codeagent',
      gitUserName: env.GIT_USER_NAME || 'CodeAgent',
      gitUserEmail: env.GIT_USER_EMAIL || 'codeagent@users.noreply.github.com',
    },
    agent: {
      defaultMode: 'ask', // plan | ask | acceptEdits | auto
      maxTurns: 60,
      bashTimeoutSec: 120,
      // Bash command prefixes that never need approval (like Claude Code allow rules).
      allowedCommands: ['ls', 'pwd', 'cat', 'git status', 'git diff', 'git log', 'git branch', 'npm test', 'npm run test', 'npm run lint', 'pytest', 'go test', 'cargo test'],
      deniedCommands: ['rm -rf /', 'sudo ', 'mkfs', ':(){'],
    },
    // Same shape as Claude Code's .mcp.json: { name: { command, args, env } }
    mcpServers: {},
    // Lifecycle hooks: { PreToolUse: [{ matcher, command }], PostToolUse: [...], Stop: [...] }
    hooks: {},
  };
}

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = base && typeof base[k] === 'object' && !Array.isArray(base[k]) && v && typeof v === 'object' && !Array.isArray(v)
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

let cache = null;

export function getSettings() {
  if (cache) return cache;
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { /* first run */ }
  cache = deepMerge(defaults(), saved);
  return cache;
}

const SECRET_KEYS = [['llm', 'apiKey'], ['github', 'token'], ['github', 'webhookSecret']];
const MASK = '••••••';

export function updateSettings(patch) {
  const current = getSettings();
  // Masked secrets coming back from the UI mean "unchanged".
  for (const [a, b] of SECRET_KEYS) {
    if (patch?.[a]?.[b] && String(patch[a][b]).startsWith(MASK)) delete patch[a][b];
  }
  cache = deepMerge(current, patch);
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
  return cache;
}

export function publicSettings() {
  const s = JSON.parse(JSON.stringify(getSettings()));
  for (const [a, b] of SECRET_KEYS) {
    if (s[a][b]) s[a][b] = MASK + String(s[a][b]).slice(-4);
  }
  return s;
}

/** Access token protecting the web UI (the agent can run shell commands!). */
export function getAccessToken() {
  if (env.ACCESS_TOKEN) return env.ACCESS_TOKEN;
  const file = path.join(DATA_DIR, '.access_token');
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { /* generate */ }
  const token = crypto.randomBytes(18).toString('base64url');
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}
