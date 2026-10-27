import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpDir(prefix = 'codeagent-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Build a scripted assistant reply. */
export const reply = {
  text: (content) => ({ content }),
  tools: (...calls) => ({ content: '', tool_calls: calls.map(([name, args], i) => ({ id: `call_${name}_${Date.now()}_${i}`, name, args })) }),
};

/**
 * Fake OpenAI-compatible server. Each POST /chat/completions consumes the next
 * scripted reply and streams it back as SSE chunks (like real providers do).
 */
export function fakeLLM(script) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const json = JSON.parse(body);
      requests.push(json);
      const next = script.shift() || { content: 'done' };
      if (next.status) { res.writeHead(next.status); res.end('{"error":"rate limited"}'); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (delta) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
      if (next.content) for (const part of next.content.match(/.{1,7}/gs)) send({ content: part });
      (next.tool_calls || []).forEach((c, index) => {
        const args = JSON.stringify(c.args);
        send({ tool_calls: [{ index, id: c.id, type: 'function', function: { name: c.name, arguments: '' } }] });
        for (const part of args.match(/.{1,10}/gs)) send({ tool_calls: [{ index, function: { arguments: part } }] });
      });
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ url: `http://127.0.0.1:${server.address().port}/v1`, requests, script, close: () => server.close() });
  }));
}
