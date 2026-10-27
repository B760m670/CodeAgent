function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|tr|br|pre|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

export const webFetch = {
  name: 'web_fetch',
  kind: 'network',
  description: 'Fetch a URL (docs, API references, raw files) and return its text content (HTML is converted to plain text).',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string' }, max_chars: { type: 'integer', description: 'Default 20000' } },
    required: ['url'],
  },
  summary: (a) => a.url,
  async run({ url, max_chars = 20000 }, ctx) {
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs are supported');
    const res = await fetch(url, { signal: ctx.signal, headers: { 'User-Agent': 'CodeAgent/0.1', Accept: 'text/html,text/plain,application/json,*/*' }, redirect: 'follow' });
    const type = res.headers.get('content-type') || '';
    let text = await res.text();
    if (type.includes('html')) text = htmlToText(text);
    const body = text.length > max_chars ? text.slice(0, max_chars) + `\n… (${text.length - max_chars} more chars)` : text;
    return `HTTP ${res.status} ${type}\n\n${body}`;
  },
};

export const todoWrite = {
  name: 'todo_write',
  kind: 'read',
  description: 'Create/update your task list for multi-step work. Send the FULL list each time. Exactly one item should be in_progress while working. Mark items completed as soon as they are done.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  async run({ todos }, ctx) {
    ctx.session.todos = todos;
    ctx.emit?.('todos', { todos });
    const done = todos.filter((t) => t.status === 'completed').length;
    return `Todo list updated (${done}/${todos.length} completed)`;
  },
};
