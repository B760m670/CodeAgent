import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveInside, relPath, walk, globToRegExp, isProbablyBinary, IGNORED_DIRS } from '../util/paths.js';
import { unifiedDiff } from '../util/diff.js';

const MAX_READ_LINES = 2000;
const MAX_LINE_LEN = 2000;

export const readFile = {
  name: 'read_file',
  kind: 'read',
  description: 'Read a text file from the workspace. Returns lines prefixed with line numbers (cat -n format). Use offset/limit for large files. Always read a file before editing it.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the workspace root' },
      offset: { type: 'integer', description: '1-based line number to start from' },
      limit: { type: 'integer', description: `Max number of lines (default ${MAX_READ_LINES})` },
    },
    required: ['path'],
  },
  async run({ path: p, offset = 1, limit = MAX_READ_LINES }, ctx) {
    const abs = resolveInside(ctx.cwd, p);
    if (!fs.existsSync(abs)) throw new Error(`File not found: ${p}`);
    if (fs.statSync(abs).isDirectory()) throw new Error(`${p} is a directory; use list_dir`);
    const buf = fs.readFileSync(abs);
    if (isProbablyBinary(buf)) return `(binary file, ${buf.length} bytes)`;
    ctx.readFiles?.add(abs);
    const lines = buf.toString('utf8').split('\n');
    const start = Math.max(1, offset);
    const slice = lines.slice(start - 1, start - 1 + limit);
    if (!slice.length) return `(empty — file has ${lines.length} lines)`;
    const out = slice.map((l, i) => `${String(start + i).padStart(6)}\t${l.length > MAX_LINE_LEN ? l.slice(0, MAX_LINE_LEN) + '…' : l}`).join('\n');
    const more = start - 1 + slice.length < lines.length ? `\n… (${lines.length - (start - 1 + slice.length)} more lines; use offset)` : '';
    return out + more;
  },
};

export const writeFile = {
  name: 'write_file',
  kind: 'edit',
  description: 'Create a new file or completely overwrite an existing one. Prefer edit_file for changing existing files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the workspace root' },
      content: { type: 'string', description: 'Full file content' },
    },
    required: ['path', 'content'],
  },
  summary: (a) => a.path,
  async run({ path: p, content }, ctx) {
    const abs = resolveInside(ctx.cwd, p);
    const existed = fs.existsSync(abs);
    const before = existed ? fs.readFileSync(abs, 'utf8') : '';
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content ?? '');
    ctx.readFiles?.add(abs);
    const diff = unifiedDiff(before, content ?? '', { file: relPath(ctx.cwd, abs) });
    return {
      content: `${existed ? 'Overwrote' : 'Created'} ${relPath(ctx.cwd, abs)} (${(content ?? '').split('\n').length} lines)`,
      display: { type: 'diff', diff },
    };
  },
};

function applyEdit(text, oldStr, newStr, replaceAll, file) {
  if (oldStr === newStr) throw new Error('old_string and new_string are identical');
  if (oldStr === '') throw new Error('old_string must not be empty (use write_file to create files)');
  const count = text.split(oldStr).length - 1;
  if (count === 0) {
    // Helpful hint: whitespace mismatch is the most common failure.
    const trimmed = oldStr.trim();
    const hint = trimmed && text.includes(trimmed) ? ' (a match exists with different leading/trailing whitespace — copy the text exactly as shown by read_file, without the line-number prefix)' : '';
    throw new Error(`old_string not found in ${file}${hint}`);
  }
  if (count > 1 && !replaceAll) throw new Error(`old_string occurs ${count} times in ${file}; include more surrounding context to make it unique, or set replace_all`);
  return replaceAll ? text.split(oldStr).join(newStr) : text.replace(oldStr, () => newStr);
}

export const editFile = {
  name: 'edit_file',
  kind: 'edit',
  description: 'Exact string replacement in a file. old_string must match the file exactly (including indentation) and be unique unless replace_all is true. You must read_file before editing.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string', description: 'Exact text to replace' },
      new_string: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  summary: (a) => a.path,
  async run({ path: p, old_string, new_string, replace_all }, ctx) {
    const abs = resolveInside(ctx.cwd, p);
    if (!fs.existsSync(abs)) throw new Error(`File not found: ${p}`);
    if (ctx.readFiles && !ctx.readFiles.has(abs)) throw new Error(`You must read ${p} with read_file before editing it`);
    const before = fs.readFileSync(abs, 'utf8');
    const after = applyEdit(before, old_string, new_string ?? '', replace_all, p);
    fs.writeFileSync(abs, after);
    return { content: `Edited ${relPath(ctx.cwd, abs)}`, display: { type: 'diff', diff: unifiedDiff(before, after, { file: relPath(ctx.cwd, abs) }) } };
  },
};

export const multiEdit = {
  name: 'multi_edit',
  kind: 'edit',
  description: 'Apply several exact string replacements to one file atomically (all or nothing). Edits are applied in order.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      edits: {
        type: 'array',
        items: {
          type: 'object',
          properties: { old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } },
          required: ['old_string', 'new_string'],
        },
      },
    },
    required: ['path', 'edits'],
  },
  summary: (a) => a.path,
  async run({ path: p, edits }, ctx) {
    const abs = resolveInside(ctx.cwd, p);
    if (!fs.existsSync(abs)) throw new Error(`File not found: ${p}`);
    if (ctx.readFiles && !ctx.readFiles.has(abs)) throw new Error(`You must read ${p} with read_file before editing it`);
    const before = fs.readFileSync(abs, 'utf8');
    let text = before;
    (edits || []).forEach((e, i) => {
      try { text = applyEdit(text, e.old_string, e.new_string ?? '', e.replace_all, p); }
      catch (err) { throw new Error(`edit #${i + 1}: ${err.message}`); }
    });
    fs.writeFileSync(abs, text);
    return { content: `Applied ${edits.length} edits to ${relPath(ctx.cwd, abs)}`, display: { type: 'diff', diff: unifiedDiff(before, text, { file: relPath(ctx.cwd, abs) }) } };
  },
};

export const listDir = {
  name: 'list_dir',
  kind: 'read',
  description: 'List a directory as a tree (ignores .git, node_modules, build output). Use depth to control recursion.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory relative to workspace root (default ".")' },
      depth: { type: 'integer', description: 'Recursion depth (default 2)' },
    },
  },
  async run({ path: p = '.', depth = 2 }, ctx) {
    const abs = resolveInside(ctx.cwd, p);
    if (!fs.existsSync(abs)) throw new Error(`Not found: ${p}`);
    const lines = [];
    const LIMIT = 500;
    const rec = (dir, prefix, d) => {
      let entries = fs.readdirSync(dir, { withFileTypes: true });
      entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
      for (const e of entries) {
        if (lines.length >= LIMIT) return;
        if (e.isDirectory()) {
          const skip = IGNORED_DIRS.has(e.name);
          lines.push(`${prefix}${e.name}/${skip ? ' (skipped)' : ''}`);
          if (!skip && d > 1) rec(path.join(dir, e.name), prefix + '  ', d - 1);
        } else lines.push(prefix + e.name);
      }
    };
    rec(abs, '', Math.max(1, depth));
    if (lines.length >= LIMIT) lines.push(`… truncated at ${LIMIT} entries`);
    return lines.join('\n') || '(empty directory)';
  },
};

export const glob = {
  name: 'glob',
  kind: 'read',
  description: 'Find files by glob pattern, e.g. "**/*.ts" or "src/**/{index,main}.js". Returns paths relative to the workspace.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string', description: 'Directory to search in (default workspace root)' },
    },
    required: ['pattern'],
  },
  async run({ pattern, path: p = '.' }, ctx) {
    const base = resolveInside(ctx.cwd, p);
    const re = globToRegExp(pattern.includes('/') ? pattern : '**/' + pattern);
    const hits = [];
    for (const rel of walk(base)) {
      if (re.test(rel.split(path.sep).join('/'))) hits.push(relPath(ctx.cwd, path.join(base, rel)));
      if (hits.length >= 300) break;
    }
    return hits.length ? hits.sort().join('\n') : 'No files matched';
  },
};

let hasRg = null;
function rgAvailable() {
  if (hasRg !== null) return Promise.resolve(hasRg);
  return new Promise((resolve) => {
    const p = spawn('rg', ['--version']);
    p.on('error', () => resolve(hasRg = false));
    p.on('close', (code) => resolve(hasRg = code === 0));
  });
}

function run(cmd, args, cwd, signal) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, signal });
    let out = '';
    p.stdout.on('data', (d) => { if (out.length < 200_000) out += d; });
    p.stderr.on('data', (d) => { if (out.length < 200_000) out += d; });
    p.on('error', (e) => resolve({ code: -1, out: e.message }));
    p.on('close', (code) => resolve({ code, out }));
  });
}

export const grep = {
  name: 'grep',
  kind: 'read',
  description: 'Search file contents with a regular expression (ripgrep syntax). Returns matching lines as path:line:text. Use glob to filter files (e.g. "*.py").',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression' },
      path: { type: 'string', description: 'File or directory (default workspace root)' },
      glob: { type: 'string', description: 'Glob filter for file names' },
      ignore_case: { type: 'boolean' },
      files_only: { type: 'boolean', description: 'Only list matching file paths' },
    },
    required: ['pattern'],
  },
  async run({ pattern, path: p = '.', glob: g, ignore_case, files_only }, ctx) {
    const target = resolveInside(ctx.cwd, p);
    const rel = relPath(ctx.cwd, target);
    let res;
    if (await rgAvailable()) {
      const args = ['--no-heading', '--line-number', '--color=never', '--max-columns=300', '--max-count=50'];
      if (ignore_case) args.push('-i');
      if (files_only) args.push('-l');
      if (g) args.push('--glob', g);
      args.push('-e', pattern, '--', rel);
      res = await run('rg', args, ctx.cwd, ctx.signal);
    } else {
      const args = ['-rnE', '--exclude-dir=.git', '--exclude-dir=node_modules', '-I'];
      if (ignore_case) args.push('-i');
      if (files_only) args.push('-l');
      if (g) args.push(`--include=${g}`);
      args.push('-e', pattern, '--', rel);
      res = await run('grep', args, ctx.cwd, ctx.signal);
    }
    if (res.code === 1 || !res.out.trim()) return 'No matches';
    const lines = res.out.trim().split('\n');
    return lines.slice(0, 300).join('\n') + (lines.length > 300 ? `\n… ${lines.length - 300} more matches` : '');
  },
};
