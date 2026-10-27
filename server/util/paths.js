import path from 'node:path';
import fs from 'node:fs';

/**
 * Resolve `p` relative to `root` and make sure the result stays inside `root`
 * (also after following symlinks of the existing part of the path).
 */
export function resolveInside(root, p = '.') {
  const absRoot = path.resolve(root);
  const target = path.resolve(absRoot, String(p || '.'));
  assertInside(absRoot, target, p);
  // Follow symlinks for the deepest existing ancestor.
  let probe = target;
  while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe);
  if (fs.existsSync(probe)) {
    const realRoot = fs.realpathSync(absRoot);
    assertInside(realRoot, fs.realpathSync(probe), p);
  }
  return target;
}

function assertInside(root, target, original) {
  const rel = path.relative(root, target);
  if (rel === '') return;
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    const err = new Error(`Path "${original}" is outside of the workspace`);
    err.status = 400;
    throw err;
  }
}

export function relPath(root, abs) {
  return path.relative(root, abs) || '.';
}

export const IGNORED_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', '.cache', 'target', '.idea']);

/** Convert a glob pattern (supports **, *, ?, {a,b}, [abc]) into a RegExp. */
export function globToRegExp(glob) {
  let re = '';
  let i = 0;
  let inGroup = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // "**/" matches zero or more directories
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 3; continue; }
        re += '.*'; i += 2; continue;
      }
      re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') { re += '(?:'; inGroup++; }
    else if (c === '}' && inGroup) { re += ')'; inGroup--; }
    else if (c === ',' && inGroup) re += '|';
    else if (c === '[') {
      const end = glob.indexOf(']', i);
      if (end === -1) re += '\\[';
      else { re += glob.slice(i, end + 1); i = end; }
    } else if ('.+^$()|\\'.includes(c)) re += '\\' + c;
    else re += c;
    i++;
  }
  return new RegExp('^' + re + '$');
}

/** Recursively walk a directory, yielding paths relative to root. */
export function* walk(root, dir = root, { maxFiles = 20000 } = {}) {
  let count = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const abs = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) stack.push(abs);
      } else if (e.isFile() || e.isSymbolicLink()) {
        yield path.relative(root, abs);
        if (++count >= maxFiles) return;
      }
    }
  }
}

export function isProbablyBinary(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}
