import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tmpDir, fakeLLM, reply } from './helpers.js';

process.env.DATA_DIR = tmpDir();

const { resolveInside, globToRegExp } = await import('../server/util/paths.js');
const { unifiedDiff } = await import('../server/util/diff.js');
const fsTools = await import('../server/tools/fs.js');
const { checkPermission } = await import('../server/tools/index.js');
const { expandCommand } = await import('../server/agent/commands.js');
const { verifySignature, parseEvent } = await import('../server/github/webhook.js');
const { chat, parseArgs } = await import('../server/llm/provider.js');
const { getSettings } = await import('../server/config.js');

test('resolveInside blocks path traversal', () => {
  const root = tmpDir();
  assert.equal(resolveInside(root, 'a/b.txt'), path.join(root, 'a/b.txt'));
  assert.throws(() => resolveInside(root, '../etc/passwd'), /outside/);
  assert.throws(() => resolveInside(root, '/etc/passwd'), /outside/);
  fs.symlinkSync('/etc', path.join(root, 'link'));
  assert.throws(() => resolveInside(root, 'link/passwd'), /outside/);
});

test('globToRegExp', () => {
  assert.ok(globToRegExp('**/*.js').test('src/a/b.js'));
  assert.ok(globToRegExp('**/*.js').test('b.js'));
  assert.ok(!globToRegExp('src/*.js').test('src/a/b.js'));
  assert.ok(globToRegExp('src/**/{index,main}.ts').test('src/x/main.ts'));
  assert.ok(!globToRegExp('*.md').test('a.mdx'));
});

test('unifiedDiff shows changed lines', () => {
  const d = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', { file: 'x' });
  assert.match(d, /^--- a\/x/);
  assert.match(d, /\n-b\n\+B/);
  assert.equal(unifiedDiff('same', 'same'), '');
});

test('edit_file requires read, unique match, and applies edits', async () => {
  const cwd = tmpDir();
  fs.writeFileSync(path.join(cwd, 'f.txt'), 'foo\nbar\nfoo\n');
  const ctx = { cwd, readFiles: new Set() };
  await assert.rejects(fsTools.editFile.run({ path: 'f.txt', old_string: 'bar', new_string: 'baz' }, ctx), /must read/);
  const read = await fsTools.readFile.run({ path: 'f.txt' }, ctx);
  assert.match(read, /^\s+1\tfoo/);
  await assert.rejects(fsTools.editFile.run({ path: 'f.txt', old_string: 'foo', new_string: 'x' }, ctx), /occurs 2 times/);
  await assert.rejects(fsTools.editFile.run({ path: 'f.txt', old_string: 'nope', new_string: 'x' }, ctx), /not found/);
  const r = await fsTools.editFile.run({ path: 'f.txt', old_string: 'bar', new_string: 'baz' }, ctx);
  assert.equal(r.display.type, 'diff');
  assert.equal(fs.readFileSync(path.join(cwd, 'f.txt'), 'utf8'), 'foo\nbaz\nfoo\n');
  await fsTools.editFile.run({ path: 'f.txt', old_string: 'foo', new_string: 'q', replace_all: true }, ctx);
  assert.equal(fs.readFileSync(path.join(cwd, 'f.txt'), 'utf8'), 'q\nbaz\nq\n');
  // multi_edit is atomic
  await assert.rejects(fsTools.multiEdit.run({ path: 'f.txt', edits: [{ old_string: 'baz', new_string: 'z' }, { old_string: 'missing', new_string: 'y' }] }, ctx), /edit #2/);
  assert.equal(fs.readFileSync(path.join(cwd, 'f.txt'), 'utf8'), 'q\nbaz\nq\n');
});

test('grep, glob and list_dir', async () => {
  const cwd = tmpDir();
  fs.mkdirSync(path.join(cwd, 'src/lib'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'node_modules/x'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src/lib/util.js'), 'export function hello() {}\n');
  fs.writeFileSync(path.join(cwd, 'node_modules/x/i.js'), 'hello');
  const ctx = { cwd };
  assert.equal(await fsTools.glob.run({ pattern: '*.js' }, ctx), 'src/lib/util.js');
  assert.match(await fsTools.grep.run({ pattern: 'function hel+o' }, ctx), /src\/lib\/util.js:1:/);
  assert.equal(await fsTools.grep.run({ pattern: 'zzz_nomatch' }, ctx), 'No matches');
  const tree = await fsTools.listDir.run({ depth: 3 }, ctx);
  assert.match(tree, /node_modules\/ \(skipped\)/);
  assert.match(tree, /util\.js/);
});

test('permissions follow the mode', () => {
  const settings = getSettings();
  const bash = { name: 'bash', kind: 'exec' };
  const edit = { name: 'edit_file', kind: 'edit' };
  const read = { name: 'read_file', kind: 'read' };
  const p = (tool, mode, args = {}) => checkPermission(tool, args, { mode, settings, sessionAllow: new Set() }).decision;
  assert.equal(p(read, 'plan'), 'allow');
  assert.equal(p(edit, 'plan'), 'deny');
  assert.equal(p(edit, 'ask'), 'ask');
  assert.equal(p(edit, 'acceptEdits'), 'allow');
  assert.equal(p(bash, 'acceptEdits', { command: 'make' }), 'ask');
  assert.equal(p(bash, 'ask', { command: 'git status' }), 'allow');
  assert.equal(p(bash, 'ask', { command: 'git status; rm -rf x' }), 'ask');
  assert.equal(p(bash, 'auto', { command: 'sudo rm' }), 'deny');
  assert.equal(p(bash, 'auto', { command: 'make' }), 'allow');
});

test('slash commands expand', () => {
  const cwd = tmpDir();
  fs.mkdirSync(path.join(cwd, '.claude/commands'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude/commands/deploy.md'), '---\ndescription: Deploy\n---\nDeploy to $ARGUMENTS now');
  assert.equal(expandCommand('/deploy staging', cwd).prompt, 'Deploy to staging now');
  assert.match(expandCommand('/review 7', cwd).prompt, /pull request #7/);
  assert.match(expandCommand('/fix-issue 42', cwd).prompt, /fix\/issue-42/);
  assert.deepEqual(expandCommand('/mode plan', cwd), { local: 'mode', args: 'plan' });
  assert.equal(expandCommand('/unknown', cwd), null);
});

test('webhook signature and event parsing', () => {
  const body = Buffer.from('{"a":1}');
  const sig = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(body).digest('hex');
  assert.ok(verifySignature('s3cret', body, sig));
  assert.ok(!verifySignature('other', body, sig));
  assert.ok(!verifySignature('', body, sig));
  const payload = {
    action: 'created',
    repository: { full_name: 'o/r' },
    issue: { number: 3, title: 'Bug', body: 'broken' },
    comment: { body: '@codeagent please fix', author_association: 'OWNER', user: { login: 'me' } },
  };
  const t = parseEvent('issue_comment', payload, '@codeagent');
  assert.equal(t.number, 3);
  assert.equal(t.isPR, false);
  assert.equal(parseEvent('issue_comment', { ...payload, comment: { ...payload.comment, author_association: 'NONE' } }, '@codeagent').ignored, 'untrusted commenter');
  assert.equal(parseEvent('issue_comment', { ...payload, comment: { ...payload.comment, body: 'hi' } }, '@codeagent'), null);
});

test('LLM client parses streamed text and tool calls, retries 429', async () => {
  const llm = await fakeLLM([{ status: 429 }, reply.tools(['read_file', { path: 'a.txt' }]), reply.text('Hello world, done.')]);
  try {
    const cfg = { baseUrl: llm.url, model: 'm', apiKey: 'k' };
    let streamed = '';
    const r1 = await chat(cfg, { messages: [{ role: 'user', content: 'hi' }], tools: [] });
    assert.equal(r1.tool_calls[0].function.name, 'read_file');
    assert.deepEqual(JSON.parse(r1.tool_calls[0].function.arguments), { path: 'a.txt' });
    const r2 = await chat(cfg, { messages: [], onText: (t) => { streamed += t; } });
    assert.equal(r2.content, 'Hello world, done.');
    assert.equal(streamed, r2.content);
    assert.equal(r2.usage.prompt_tokens, 100);
  } finally { llm.close(); }
});

test('parseArgs tolerates sloppy JSON', () => {
  assert.deepEqual(parseArgs('{"a":1,}'), { a: 1 });
  assert.deepEqual(parseArgs('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(parseArgs(''), {});
});
