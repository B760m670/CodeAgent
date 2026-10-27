/**
 * Minimal line-based unified diff (LCS). Good enough for showing edits in the UI.
 */
export function unifiedDiff(oldText, newText, { file = 'file', context = 3 } = {}) {
  const toLines = (t) => (t === '' ? [] : t.replace(/\n$/, '').split('\n'));
  const a = toLines(oldText);
  const b = toLines(newText);

  // Trim common prefix/suffix to keep the LCS table small.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);

  let ops;
  if (am.length * bm.length > 4_000_000) {
    ops = [...am.map((l) => ['-', l]), ...bm.map((l) => ['+', l])];
  } else {
    const n = am.length, m = bm.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
    ops = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) { ops.push([' ', am[i]]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(['-', am[i++]]);
      else ops.push(['+', bm[j++]]);
    }
    while (i < n) ops.push(['-', am[i++]]);
    while (j < m) ops.push(['+', bm[j++]]);
  }
  const all = [
    ...a.slice(0, pre).map((l) => [' ', l]),
    ...ops,
    ...a.slice(a.length - suf).map((l) => [' ', l]),
  ];

  // Group into hunks.
  const lines = [`--- a/${file}`, `+++ b/${file}`];
  let idx = 0, oldLine = 1, newLine = 1;
  const changed = all.map((o) => o[0] !== ' ');
  if (!changed.some(Boolean)) return '';
  while (idx < all.length) {
    // find next change
    let k = idx;
    while (k < all.length && !changed[k]) { k++; }
    if (k >= all.length) break;
    const start = Math.max(idx, k - context);
    // advance line counters up to start
    for (let t = idx; t < start; t++) { oldLine++; newLine++; }
    let end = k;
    let lastChange = k;
    while (end < all.length) {
      if (changed[end]) lastChange = end;
      else if (end - lastChange > context * 2) break;
      end++;
    }
    end = Math.min(all.length, lastChange + context + 1);
    const hunk = all.slice(start, end);
    const oldCount = hunk.filter((o) => o[0] !== '+').length;
    const newCount = hunk.filter((o) => o[0] !== '-').length;
    lines.push(`@@ -${oldCount ? oldLine : oldLine - 1},${oldCount} +${newCount ? newLine : newLine - 1},${newCount} @@`);
    for (const [op, l] of hunk) lines.push(op + l);
    oldLine += oldCount;
    newLine += newCount;
    idx = end;
  }
  return lines.join('\n');
}
