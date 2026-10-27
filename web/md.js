// Tiny, safe markdown renderer (escapes all HTML first).
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

function block(text) {
  const lines = esc(text).split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if ((m = l.match(/^(#{1,6})\s+(.*)$/))) { out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++; continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (/^\s*&gt;/.test(l)) {
      const q = [];
      while (i < lines.length && /^\s*&gt;/.test(lines[i])) q.push(lines[i++].replace(/^\s*&gt;\s?/, ''));
      out.push(`<blockquote>${inline(q.join('<br>'))}</blockquote>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const row = (r, tag) => '<tr>' + r.trim().replace(/^\||\|$/g, '').split('|').map((c) => `<${tag}>${inline(c.trim())}</${tag}>`).join('') + '</tr>';
      let html = '<table>' + row(l, 'th');
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) html += row(lines[i++], 'td');
      out.push(html + '</table>');
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      const ordered = /^\s*\d/.test(l);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        let item = lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, '');
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) item += ' ' + lines[i++].trim();
        item = item.replace(/^\[ \]\s/, '☐ ').replace(/^\[x\]\s/i, '☑ ');
        items.push(`<li>${inline(item)}</li>`);
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*([-*+]|\d+[.)])\s+|\s*&gt;|\s*\|)/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    out.push(`<p>${inline(para.join('<br>'))}</p>`);
  }
  return out.join('');
}

export function markdown(src) {
  const parts = String(src ?? '').split(/^```/m);
  let html = '';
  parts.forEach((part, idx) => {
    if (idx % 2 === 0) { html += block(part); return; }
    const nl = part.indexOf('\n');
    const lang = nl === -1 ? '' : part.slice(0, nl).trim();
    const code = nl === -1 ? '' : part.slice(nl + 1).replace(/\n$/, '');
    html += `<pre><code${lang ? ` data-lang="${esc(lang)}"` : ''}>${esc(code)}</code></pre>`;
  });
  return html;
}

export function renderDiff(diff) {
  if (!diff) return '<div class="muted">(без изменений)</div>';
  return '<div class="diff">' + diff.split('\n').map((l) => {
    let cls = '';
    if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ') || l.startsWith('new file')) cls = 'meta';
    else if (l.startsWith('@@')) cls = 'hunk';
    else if (l.startsWith('+')) cls = 'add';
    else if (l.startsWith('-')) cls = 'del';
    return `<div class="${cls}">${esc(l) || ' '}</div>`;
  }).join('') + '</div>';
}

/** Split a multi-file git diff into [{file, diff}]. */
export function splitDiff(diff) {
  const files = [];
  let cur = null;
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('diff --git')) {
      cur = { file: line.replace(/^diff --git a\/(.+?) b\/.*$/, '$1').replace(/^diff --git \/dev\/null b\//, ''), lines: [] };
      files.push(cur);
    }
    if (cur) cur.lines.push(line);
  }
  return files.map((f) => ({ file: f.file, diff: f.lines.join('\n') }));
}
