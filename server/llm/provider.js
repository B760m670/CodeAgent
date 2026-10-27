/**
 * Client for any OpenAI-compatible /chat/completions endpoint (OpenRouter,
 * Groq, Gemini, Cerebras, Mistral, Ollama, LM Studio, vLLM...), with streaming,
 * tool calling, retries and model fallback for rate-limited free tiers.
 */

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('Aborted')); }, { once: true });
});

export class LLMError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/**
 * @param {object} cfg   settings.llm
 * @param {object} req   { messages, tools, signal, onText }
 * @returns {Promise<{content: string, tool_calls: any[], usage: any, model: string}>}
 */
export async function chat(cfg, { messages, tools, signal, onText, maxTokens }) {
  const models = [cfg.model, ...(cfg.fallbackModels || [])].filter(Boolean);
  if (!cfg.baseUrl || !models.length) throw new LLMError('LLM is not configured: set base URL and model in Settings');
  let lastErr;
  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await chatOnce(cfg, model, { messages, tools, signal, onText, maxTokens });
      } catch (err) {
        if (signal?.aborted) throw err;
        lastErr = err;
        if (!RETRYABLE.has(err.status) && err.status !== undefined) break; // try next model
        if (err.partial) throw err; // already streamed text: don't duplicate it
        await sleep(1500 * 2 ** attempt, signal);
      }
    }
  }
  throw lastErr;
}

async function chatOnce(cfg, model, { messages, tools, signal, onText, maxTokens }) {
  const body = {
    model,
    messages,
    stream: true,
    temperature: cfg.temperature ?? 0.2,
    max_tokens: maxTokens || cfg.maxTokens || 8192,
  };
  if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }

  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  if (cfg.baseUrl.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://github.com/codeagent';
    headers['X-Title'] = 'CodeAgent';
  }

  let res;
  try {
    res = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', headers, body: JSON.stringify(body), signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    const e = new LLMError(`Network error contacting LLM: ${err.message}`);
    e.status = 503;
    throw e;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new LLMError(`LLM HTTP ${res.status} (${model}): ${text.slice(0, 500)}`, res.status);
  }

  const ctype = res.headers.get('content-type') || '';
  if (!ctype.includes('text/event-stream')) {
    // Provider ignored stream=true.
    const json = await res.json();
    if (json.error) throw new LLMError(`LLM error: ${JSON.stringify(json.error).slice(0, 500)}`, json.error.code);
    const msg = json.choices?.[0]?.message || {};
    if (msg.content) onText?.(msg.content);
    return { content: msg.content || '', tool_calls: normalizeToolCalls(msg.tool_calls || []), usage: json.usage, model };
  }

  let content = '';
  const calls = [];
  let usage = null;
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let json;
      try { json = JSON.parse(data); } catch { continue; }
      if (json.error) {
        const e = new LLMError(`LLM stream error: ${JSON.stringify(json.error).slice(0, 500)}`, json.error.code || 500);
        e.partial = content.length > 0;
        throw e;
      }
      if (json.usage) usage = json.usage;
      const delta = json.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) { content += delta.content; onText?.(delta.content); }
      for (const tc of delta.tool_calls || []) {
        const i = tc.index ?? calls.length;
        calls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].function.name += tc.function.name;
        if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
      }
    }
  }
  return { content, tool_calls: normalizeToolCalls(calls.filter(Boolean)), usage, model };
}

let idCounter = 0;
function normalizeToolCalls(calls) {
  return calls.filter((c) => c.function?.name).map((c) => ({
    id: c.id || `call_${Date.now().toString(36)}_${idCounter++}`,
    type: 'function',
    function: { name: c.function.name, arguments: c.function.arguments || '{}' },
  }));
}

/** Parse tool-call arguments leniently (free models sometimes emit sloppy JSON). */
export function parseArgs(raw) {
  if (!raw || !raw.trim()) return {};
  try { return JSON.parse(raw); } catch { /* try to repair */ }
  const cleaned = raw.trim().replace(/^```(?:json)?/, '').replace(/```$/, '').replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(cleaned);
}
