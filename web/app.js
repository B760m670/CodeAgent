import { esc, markdown, renderDiff, splitDiff } from './md.js';

const $ = (s) => document.querySelector(s);
const state = {
  workspace: localStorage.getItem('ca.ws') || '',
  session: null,
  running: false,
  es: null,
  commands: [],
  current: null, // streaming assistant bubble
  cards: new Map(), // tool call id -> card element
  openFile: null,
  settings: null,
};

/* ---------------- API ---------------- */
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && url !== '/api/login') { showLogin(); throw new Error('Требуется вход'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), isError ? 6000 : 2500);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

/* ---------------- Auth ---------------- */
function showLogin() {
  $('#login').classList.remove('hidden');
  $('#app').classList.add('hidden');
  $('#login-token').focus();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('POST', '/api/login', { token: $('#login-token').value.trim() });
    $('#login').classList.add('hidden');
    boot();
  } catch (err) { $('#login-error').textContent = err.message; }
});
$('#logout-btn').onclick = guard(async () => { await api('POST', '/api/logout'); location.reload(); });

/* ---------------- Boot ---------------- */
async function boot() {
  try { await api('GET', '/api/me'); } catch { return; }
  $('#app').classList.remove('hidden');
  state.settings = await api('GET', '/api/settings');
  updateModelBadge();
  if (!state.settings.llm.apiKey && state.settings.llm.provider !== 'ollama') {
    toast('Укажите API-ключ бесплатного LLM-провайдера в настройках ⚙');
  }
  await loadWorkspaces();
}

function updateModelBadge() {
  $('#model-badge').textContent = `${state.settings.llm.provider} · ${state.settings.llm.model}`;
}

async function loadWorkspaces() {
  const list = await api('GET', '/api/workspaces');
  const sel = $('#ws-select');
  sel.innerHTML = list.length ? list.map((w) => `<option value="${esc(w.name)}">${esc(w.name)}</option>`).join('') : '<option value="">— нет репозиториев —</option>';
  if (!list.find((w) => w.name === state.workspace)) state.workspace = list[0]?.name || '';
  sel.value = state.workspace;
  await selectWorkspace(state.workspace);
  if (!list.length) openNewWorkspace();
}

$('#ws-select').onchange = (e) => selectWorkspace(e.target.value);

async function selectWorkspace(name) {
  state.workspace = name;
  localStorage.setItem('ca.ws', name);
  closeSession();
  $('#file-tree').innerHTML = '';
  $('#session-list').innerHTML = '';
  if (!name) return;
  loadTree();
  refreshGit();
  state.commands = await api('GET', `/api/workspaces/${enc(name)}/commands`).catch(() => []);
  const sessions = await loadSessions();
  const last = localStorage.getItem('ca.session.' + name);
  if (last && sessions.find((s) => s.id === last)) openSession(last);
}

const enc = encodeURIComponent;
const wsUrl = (p) => `/api/workspaces/${enc(state.workspace)}${p}`;

/* ---------------- Sessions ---------------- */
async function loadSessions() {
  const list = await api('GET', `/api/sessions?workspace=${enc(state.workspace)}`);
  $('#session-list').innerHTML = list.map((s) => `
    <li data-id="${s.id}" class="${state.session?.id === s.id ? 'active' : ''}">
      <span>${s.source === 'github' ? '🐙' : '💬'}</span>
      <span class="title" title="${esc(s.title)}">${esc(s.title)}</span>
      <button class="icon-btn small del" data-del="${s.id}" title="Удалить">✕</button>
    </li>`).join('') || '<li class="muted">Нет сессий</li>';
  return list;
}

$('#session-list').onclick = guard(async (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    if (!confirm('Удалить сессию?')) return;
    await api('DELETE', `/api/sessions/${del.dataset.del}`);
    if (state.session?.id === del.dataset.del) closeSession();
    return loadSessions();
  }
  const li = e.target.closest('li[data-id]');
  if (li) { openSession(li.dataset.id); $('#left').classList.remove('open'); }
});

$('#new-session-btn').onclick = guard(async () => {
  if (!state.workspace) return openNewWorkspace();
  const s = await api('POST', '/api/sessions', { workspace: state.workspace, mode: $('#mode-select').value });
  await loadSessions();
  await openSession(s.id);
  $('#input').focus();
});

function closeSession() {
  state.es?.close();
  state.es = null;
  state.session = null;
  state.cards.clear();
  state.current = null;
  $('#messages').innerHTML = '';
  $('#messages').append(emptyState);
  $('#todos').classList.add('hidden');
  setRunning(false);
}
const emptyState = $('#empty-state');

async function openSession(id) {
  closeSession();
  const s = await api('GET', `/api/sessions/${id}`);
  state.session = s;
  localStorage.setItem('ca.session.' + state.workspace, id);
  document.querySelectorAll('#session-list li').forEach((li) => li.classList.toggle('active', li.dataset.id === id));
  $('#mode-select').value = s.mode;
  renderHistory(s);
  renderTodos(s.todos);
  connectEvents(id);
  setRunning(s.status.running);
}

function renderHistory(s) {
  const box = $('#messages');
  box.innerHTML = '';
  let msgs = s.messages;
  if (s.status?.running) {
    // The SSE stream replays the current run (from its user message on), so render only what came before it.
    const lastUser = msgs.findLastIndex((m) => m.role === 'user');
    msgs = msgs.slice(0, Math.max(lastUser, 0));
  }
  if (!msgs.length && !s.status?.running) box.append(emptyState);
  for (const m of msgs) {
    if (m.role === 'user') {
      if (String(m.content).startsWith('[Summary of the earlier conversation')) addNote('🗜 Контекст был сжат (compact). Краткое содержание:\n' + m.content.split('\n').slice(1).join('\n'));
      else addUser(m.content);
    } else if (m.role === 'assistant') {
      if (m.content) addAssistant(m.content);
      for (const c of m.tool_calls || []) {
        let args = {};
        try { args = JSON.parse(c.function.arguments); } catch { /* raw */ }
        addToolCard({ id: c.id, name: c.function.name, args });
      }
    } else if (m.role === 'tool') {
      const d = s.displays?.[m.tool_call_id] || {};
      finishToolCard({ id: m.tool_call_id, content: m.content, display: d.display, isError: d.isError });
    }
  }
  scrollDown(true);
}

/* ---------------- Live events ---------------- */
function connectEvents(id) {
  const es = new EventSource(`/api/sessions/${id}/events`);
  state.es = es;
  es.onmessage = (e) => {
    if (state.session?.id !== id) return;
    handleEvent(JSON.parse(e.data));
  };
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'run_start':
      emptyState.remove();
      addUser(ev.user);
      setRunning(true);
      break;
    case 'text':
      if (!state.current) state.current = addAssistant('', true);
      state.current.raw += ev.text;
      scheduleRender(state.current);
      break;
    case 'assistant_message':
      if (state.current) { state.current.raw = ev.message.content || state.current.raw; renderBubble(state.current); state.current.el.classList.remove('cursor'); }
      state.current = null;
      break;
    case 'tool_call': addToolCard(ev, true); break;
    case 'tool_progress': {
      const card = state.cards.get(ev.id);
      if (card) { const pre = card.querySelector('pre.live') || card.querySelector('.tbody').appendChild(Object.assign(document.createElement('pre'), { className: 'out live' })); pre.textContent += ev.chunk; pre.scrollTop = pre.scrollHeight; }
      break;
    }
    case 'tool_result': finishToolCard(ev); break;
    case 'permission_request': showPermission(ev); break;
    case 'permission_resolved': document.querySelector(`.perm[data-req="${ev.requestId}"]`)?.remove(); break;
    case 'todos': renderTodos(ev.todos); break;
    case 'usage': $('#usage').textContent = `${ev.model || ''} · ↑${fmt(ev.prompt_tokens)} ↓${fmt(ev.completion_tokens)} токенов`; break;
    case 'compacted': addNote('🗜 Контекст сжат: старые сообщения заменены кратким содержанием.'); break;
    case 'hook': if (ev.code !== 0) addNote(`Hook ${ev.event}: ${ev.command} → exit ${ev.code}\n${ev.stderr || ev.stdout}`); break;
    case 'error': addNote('⚠ ' + ev.message, true); break;
    case 'mode': $('#mode-select').value = ev.mode; toast('Режим: ' + ev.mode); break;
    case 'cleared': openSession(state.session.id); break;
    case 'done':
      if (state.current) state.current.el.classList.remove('cursor');
      state.current = null;
      setRunning(false);
      loadSessions();
      refreshGit();
      loadTree(true);
      if (state.openFile) openFile(state.openFile, true);
      if (!$('[data-tab="changes"].tab-body').classList.contains('hidden')) loadDiff();
      break;
  }
  scrollDown();
}

const fmt = (n) => (n > 9999 ? (n / 1000).toFixed(1) + 'k' : n);

function setRunning(r) {
  state.running = r;
  $('#stop-btn').classList.toggle('hidden', !r);
  $('#send-btn').disabled = r;
}

/* ---------------- Rendering ---------------- */
function nearBottom() { const m = $('#messages'); return m.scrollHeight - m.scrollTop - m.clientHeight < 120; }
function scrollDown(force) { const m = $('#messages'); if (force || nearBottom()) m.scrollTop = m.scrollHeight; }

function addUser(text) {
  const el = document.createElement('div');
  el.className = 'msg user';
  el.innerHTML = `<div class="bubble"></div>`;
  el.querySelector('.bubble').textContent = text;
  $('#messages').append(el);
  scrollDown(true);
}

function addAssistant(text, streaming = false) {
  const el = document.createElement('div');
  el.className = 'msg assistant';
  el.innerHTML = `<div class="bubble${streaming ? ' cursor' : ''}"></div>`;
  $('#messages').append(el);
  const b = { el: el.querySelector('.bubble'), raw: text };
  renderBubble(b);
  return b;
}
function renderBubble(b) { b.el.innerHTML = markdown(b.raw); }
function scheduleRender(b) {
  if (b.pending) return;
  b.pending = requestAnimationFrame(() => { b.pending = 0; renderBubble(b); scrollDown(); });
}

function addNote(text, isError) {
  const el = document.createElement('div');
  el.className = 'note' + (isError ? ' error' : '');
  el.textContent = text;
  $('#messages').append(el);
}

const TOOL_ICONS = { read_file: '📄', write_file: '📝', edit_file: '✏️', multi_edit: '✏️', list_dir: '📁', glob: '🔎', grep: '🔎', bash: '⌨️', web_fetch: '🌐', todo_write: '☑', task: '🤖' };
function toolSummary(name, args) {
  if (!args || typeof args !== 'object') return '';
  return args.command || args.path || args.pattern || args.url || args.message || args.title || args.description || args.name || (args.number ? '#' + args.number : '') || args.prompt?.slice(0, 80) || '';
}

function addToolCard(ev, live = false) {
  const card = document.createElement('details');
  card.className = 'tool';
  const icon = TOOL_ICONS[ev.name] || (ev.name.startsWith('git') ? '🌿' : ev.name.startsWith('mcp__') ? '🔌' : '🔧');
  card.innerHTML = `<summary><span>${icon}</span><span class="tname">${esc(ev.name)}</span><span class="tsum">${esc(ev.summary || toolSummary(ev.name, ev.args))}</span><span class="status ${live ? 'running' : ''}"></span></summary>
    <div class="tbody"><div class="muted small-text">Аргументы</div><pre class="out">${esc(JSON.stringify(ev.args, null, 2))}</pre></div>`;
  $('#messages').append(card);
  state.cards.set(ev.id, card);
  return card;
}

function finishToolCard(ev) {
  const card = state.cards.get(ev.id);
  if (!card) return;
  const st = card.querySelector('.status');
  st.className = 'status ' + (ev.isError ? 'err' : 'ok');
  st.textContent = ev.isError ? '✕ ошибка' : '✓';
  card.querySelector('pre.live')?.remove();
  card.classList.toggle('err', !!ev.isError);
  const body = card.querySelector('.tbody');
  if (ev.display?.type === 'diff') {
    body.insertAdjacentHTML('afterbegin', renderDiff(ev.display.diff));
    card.open = true;
  }
  const out = document.createElement('pre');
  out.className = 'out';
  out.textContent = ev.content;
  body.insertAdjacentHTML('beforeend', '<div class="muted small-text" style="margin-top:6px">Результат</div>');
  body.append(out);
  if (ev.isError) card.open = true;
  if (ev.name === 'todo_write') card.open = false;
}

function showPermission(ev) {
  let card = state.cards.get(ev.id) || addToolCard(ev, true);
  card.open = true;
  const what = ev.kind === 'exec' ? 'Выполнить команду?' : ev.kind === 'edit' ? 'Изменить файлы?' : ev.kind === 'remote' ? 'Действие на GitHub / remote?' : 'Разрешить действие?';
  const preview = ev.args.command || (ev.args.content !== undefined ? `${ev.args.path}\n\n${ev.args.content}` : ev.args.old_string !== undefined ? `${ev.args.path}\n- ${ev.args.old_string}\n+ ${ev.args.new_string}` : JSON.stringify(ev.args, null, 2));
  const div = document.createElement('div');
  div.className = 'perm';
  div.dataset.req = ev.requestId;
  div.innerHTML = `<div class="q">🔐 ${what} <span class="mono muted">${esc(ev.name)}</span></div>
    <pre>${esc(String(preview).slice(0, 5000))}</pre>
    <input placeholder="Комментарий для агента при отказе (необязательно)">
    <div class="row">
      <button class="btn green small" data-d="allow">Разрешить</button>
      <button class="btn small" data-d="always">Разрешать ${esc(ev.name)} в этой сессии</button>
      <button class="btn danger small" data-d="deny">Отклонить</button>
    </div>`;
  div.onclick = guard(async (e) => {
    const d = e.target.dataset.d;
    if (!d) return;
    await api('POST', `/api/sessions/${state.session.id}/permission`, { requestId: ev.requestId, decision: d, feedback: div.querySelector('input').value });
    div.remove();
  });
  card.append(div);
  scrollDown(true);
  if (document.hidden && Notification?.permission === 'granted') new Notification('CodeAgent ждёт подтверждения', { body: ev.name });
}

function renderTodos(todos) {
  const box = $('#todos');
  if (!todos?.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const icon = { pending: '○', in_progress: '▸', completed: '✓' };
  box.innerHTML = `<div class="muted small-text">План (${todos.filter((t) => t.status === 'completed').length}/${todos.length})</div>` +
    todos.map((t) => `<div class="t ${t.status}">${icon[t.status] || '○'} ${esc(t.content)}</div>`).join('');
}

/* ---------------- Composer ---------------- */
const input = $('#input');
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + 'px';
  updateCmdMenu();
});
input.addEventListener('keydown', (e) => {
  const menu = $('#cmd-menu');
  if (!menu.classList.contains('hidden')) {
    const items = [...menu.children];
    let i = items.findIndex((x) => x.classList.contains('sel'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[i]?.classList.remove('sel');
      i = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[i].classList.add('sel');
      return;
    }
    if ((e.key === 'Tab' || e.key === 'Enter') && items[i]) { e.preventDefault(); pickCmd(items[i].dataset.name); return; }
    if (e.key === 'Escape') { menu.classList.add('hidden'); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); }
});

function updateCmdMenu() {
  const menu = $('#cmd-menu');
  const m = input.value.match(/^\/([\w:-]*)$/);
  if (!m) { menu.classList.add('hidden'); return; }
  const items = state.commands.filter((c) => c.name.startsWith(m[1]));
  if (!items.length) { menu.classList.add('hidden'); return; }
  menu.innerHTML = items.map((c, i) => `<div data-name="${esc(c.name)}" class="${i === 0 ? 'sel' : ''}"><b>/${esc(c.name)}</b><span class="muted">${esc(c.description)}${c.builtin ? '' : ' (custom)'}</span></div>`).join('');
  menu.classList.remove('hidden');
}
function pickCmd(name) { input.value = `/${name} `; $('#cmd-menu').classList.add('hidden'); input.focus(); }
$('#cmd-menu').onclick = (e) => { const d = e.target.closest('[data-name]'); if (d) pickCmd(d.dataset.name); };

$('#composer').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || state.running) return;
  if (!state.workspace) return openNewWorkspace();
  if (!state.session) {
    const s = await api('POST', '/api/sessions', { workspace: state.workspace, mode: $('#mode-select').value });
    await loadSessions();
    await openSession(s.id);
  }
  input.value = '';
  input.style.height = 'auto';
  $('#cmd-menu').classList.add('hidden');
  emptyState.remove();
  await api('POST', `/api/sessions/${state.session.id}/messages`, { text, mode: $('#mode-select').value });
  if (Notification?.permission === 'default') Notification.requestPermission().catch(() => {});
}));

$('#stop-btn').onclick = guard(() => api('POST', `/api/sessions/${state.session.id}/stop`));
$('#mode-select').onchange = guard(async (e) => {
  if (state.session) await api('PATCH', `/api/sessions/${state.session.id}`, { mode: e.target.value });
});

/* ---------------- File tree & viewer ---------------- */
async function loadTree(keepOpen = false) {
  if (!state.workspace) return;
  const box = $('#file-tree');
  const opened = keepOpen ? [...box.querySelectorAll('.node.dir.open')].map((n) => n.dataset.path) : [];
  box.innerHTML = '';
  await renderDir(box, '.', 0);
  for (const p of opened) {
    const n = box.querySelector(`.node.dir[data-path="${CSS.escape(p)}"]`);
    if (n) await toggleDir(n);
  }
}

async function renderDir(container, rel) {
  const items = await api('GET', wsUrl(`/tree?path=${enc(rel)}`)).catch(() => []);
  for (const it of items) {
    const n = document.createElement('div');
    n.className = 'node' + (it.dir ? ' dir' : '');
    n.dataset.path = it.path;
    n.textContent = (it.dir ? '▸ 📁 ' : '   ') + it.name;
    if (it.ignored) n.style.opacity = '.5';
    container.append(n);
    if (it.dir) {
      const ch = document.createElement('div');
      ch.className = 'children hidden';
      container.append(ch);
    }
  }
}

async function toggleDir(n) {
  const ch = n.nextElementSibling;
  const open = ch.classList.toggle('hidden') === false;
  n.classList.toggle('open', open);
  n.textContent = n.textContent.replace(/^[▸▾]/, open ? '▾' : '▸');
  if (open && !ch.childElementCount) await renderDir(ch, n.dataset.path);
}

$('#file-tree').onclick = guard(async (e) => {
  const n = e.target.closest('.node');
  if (!n) return;
  if (n.classList.contains('dir')) return toggleDir(n);
  document.querySelectorAll('#file-tree .node.active').forEach((x) => x.classList.remove('active'));
  n.classList.add('active');
  await openFile(n.dataset.path);
  showRight('file');
  $('#left').classList.remove('open');
});
$('#refresh-tree').onclick = guard(() => loadTree(true));

async function openFile(p, silent = false) {
  let f;
  try { f = await api('GET', wsUrl(`/file?path=${enc(p)}`)); } catch (e) { if (!silent) throw e; return; }
  state.openFile = p;
  $('#file-path').textContent = p;
  $('#file-view').innerHTML = f.content.split('\n').map((l) => `<span class="ln">${esc(l) || ' '}</span>`).join('');
  $('#file-edit-btn').classList.toggle('hidden', f.binary);
  $('#file-editor').value = f.content;
  if (!silent) setEditing(false);
}
function setEditing(on) {
  $('#file-view').classList.toggle('hidden', on);
  $('#file-editor').classList.toggle('hidden', !on);
  $('#file-save-btn').classList.toggle('hidden', !on);
  $('#file-edit-btn').textContent = on ? 'Отмена' : 'Редактировать';
}
$('#file-edit-btn').onclick = () => setEditing($('#file-editor').classList.contains('hidden'));
$('#file-save-btn').onclick = guard(async () => {
  await api('PUT', wsUrl(`/file?path=${enc(state.openFile)}`), { content: $('#file-editor').value });
  toast('Сохранено');
  await openFile(state.openFile);
  refreshGit();
});

/* ---------------- Right panel ---------------- */
function showRight(tab) {
  $('.layout').classList.remove('no-right');
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-body').forEach((b) => b.classList.toggle('hidden', b.dataset.tab !== tab));
  if (tab === 'changes') loadDiff();
  if (tab === 'git') refreshGit();
  if (tab === 'github') loadGitHub();
}
document.querySelectorAll('.tabs button').forEach((b) => { b.onclick = () => showRight(b.dataset.tab); });
$('#toggle-right').onclick = () => $('.layout').classList.toggle('no-right');
$('#toggle-left').onclick = () => $('#left').classList.toggle('open');
const narrow = matchMedia('(max-width: 1000px)');
if (narrow.matches) $('.layout').classList.add('no-right');
narrow.addEventListener('change', (e) => { if (e.matches) $('.layout').classList.add('no-right'); });

async function loadDiff(file) {
  const { diff } = await api('GET', wsUrl(`/diff${file ? `?path=${enc(file)}` : ''}`));
  const files = splitDiff(diff);
  $('#diff-view').innerHTML = files.length
    ? files.map((f) => `<div class="diff-file"><div class="fname">${esc(f.file)}</div>${renderDiff(f.diff)}</div>`).join('')
    : '<p class="muted">Нет незакоммиченных изменений.</p>';
}
$('#refresh-diff').onclick = guard(() => loadDiff());

async function refreshGit() {
  if (!state.workspace) return;
  const g = await api('GET', wsUrl('/git')).catch(() => null);
  if (!g) return;
  $('#branch-badge').textContent = g.branch ? '⎇ ' + g.branch : '';
  const panel = $('#git-panel');
  const local = g.branches.filter((b) => !b.name.startsWith('origin'));
  panel.innerHTML = `
    <div class="row"><b>⎇ ${esc(g.branch || '—')}</b><span class="muted small-text">${esc(g.tracking)}</span></div>
    <div class="row" style="margin-top:8px">
      <select id="git-branch-sel">${local.map((b) => `<option ${b.current ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>
      <button class="btn small" data-git="checkout">Переключить</button>
      <button class="btn small" data-git="create-branch">＋ Ветка</button>
    </div>
    <div class="row" style="margin-top:8px">
      <button class="btn small" data-git="pull">⇣ Pull</button>
      <button class="btn small" data-git="push">⇡ Push</button>
      <button class="btn small" data-git="fetch">Fetch</button>
      <button class="btn small" data-git="merge">Слить ветку в текущую…</button>
    </div>
    <h4>Изменённые файлы (${g.files.length})</h4>
    ${g.files.map((f) => `<div class="file" data-file="${esc(f.path)}"><span class="st">${esc(f.status)}</span>${esc(f.path)}</div>`).join('') || '<div class="muted small-text">Рабочее дерево чистое</div>'}
    ${g.files.length ? `<div class="row" style="margin-top:8px"><input id="commit-msg" placeholder="Сообщение коммита" style="flex:1"><button class="btn small primary" data-git="commit">Commit</button><button class="btn small danger" data-git="discard">Откатить</button></div>
    <div class="row" style="margin-top:6px"><button class="btn small" id="ask-commit">🤖 Попросить агента: /commit</button></div>` : ''}
    <h4>История</h4>
    <div class="log">${esc(g.log.join('\n')) || '<span class="muted">нет коммитов</span>'}</div>`;
}

$('#git-panel').onclick = guard(async (e) => {
  const f = e.target.closest('[data-file]');
  if (f) { showRight('changes'); return loadDiff(f.dataset.file); }
  if (e.target.id === 'ask-commit') { input.value = '/commit'; return $('#composer').requestSubmit(); }
  const action = e.target.dataset.git;
  if (!action) return;
  const body = { action };
  if (action === 'checkout') body.branch = $('#git-branch-sel').value;
  if (action === 'create-branch') { body.branch = prompt('Имя новой ветки', 'feature/'); if (!body.branch) return; }
  if (action === 'merge') { body.branch = prompt('Какую ветку слить в текущую?', $('#git-branch-sel').value); if (!body.branch) return; }
  if (action === 'commit') { body.message = $('#commit-msg').value.trim(); if (!body.message) return toast('Введите сообщение коммита', true); }
  if (action === 'discard' && !confirm('Откатить все незакоммиченные изменения в отслеживаемых файлах?')) return;
  e.target.disabled = true;
  try {
    const r = await api('POST', wsUrl('/git'), body);
    toast(r.output?.trim().split('\n').pop() || 'Готово');
  } finally { e.target.disabled = false; }
  refreshGit();
  loadTree(true);
});

async function loadGitHub() {
  const panel = $('#github-panel');
  panel.innerHTML = '<p class="muted">Загрузка…</p>';
  try {
    const [prs, issues, g] = await Promise.all([
      api('GET', wsUrl('/github/pulls')),
      api('GET', wsUrl('/github/issues')),
      api('GET', wsUrl('/git')),
    ]);
    panel.innerHTML = `
      <div class="row"><b>${esc(prs.repo)}</b><div class="spacer"></div><a href="https://github.com/${esc(prs.repo)}" target="_blank" rel="noopener">открыть ↗</a></div>
      <h4>Новый Pull Request из ⎇ ${esc(g.branch)}</h4>
      <div class="row"><input id="pr-title" placeholder="Заголовок PR" style="flex:1"><button class="btn small primary" id="pr-create">Создать</button></div>
      <div class="row" style="margin-top:6px"><button class="btn small" id="pr-agent">🤖 Агент: /pr (ветка, коммит, push, PR)</button></div>
      <h4>Pull Requests (${prs.items.length})</h4>
      ${prs.items.map((p) => `<div class="item"><div class="grow"><a href="${esc(p.url)}" target="_blank" rel="noopener">#${p.number} ${esc(p.title)}</a><div class="sub">${esc(p.head)} → ${esc(p.base)} · ${esc(p.user)}${p.draft ? ' · draft' : ''}</div></div>
        <button class="btn small" data-review="${p.number}">Ревью</button><button class="btn small green" data-merge="${p.number}">Merge</button></div>`).join('') || '<p class="muted small-text">Нет открытых PR</p>'}
      <h4>Issues (${issues.items.length})</h4>
      ${issues.items.map((i) => `<div class="item"><div class="grow"><a href="${esc(i.url)}" target="_blank" rel="noopener">#${i.number} ${esc(i.title)}</a><div class="sub">${esc(i.user)}</div></div>
        <button class="btn small primary" data-fix="${i.number}">🤖 Исправить</button></div>`).join('') || '<p class="muted small-text">Нет открытых issues</p>'}`;
    panel.dataset.branch = g.branch;
  } catch (e) {
    panel.innerHTML = `<p class="error-text">${esc(e.message)}</p><p class="muted small-text">Для работы с GitHub нужен токен (Настройки ⚙) и репозиторий, склонированный с github.com.</p>`;
  }
}

$('#github-panel').onclick = guard(async (e) => {
  const t = e.target;
  const send = (text) => { input.value = text; $('#composer').requestSubmit(); };
  if (t.id === 'pr-agent') return send('/pr');
  if (t.dataset.fix) return send(`/fix-issue ${t.dataset.fix}`);
  if (t.dataset.review) return send(`/review ${t.dataset.review}`);
  if (t.id === 'pr-create') {
    const title = $('#pr-title').value.trim();
    if (!title) return toast('Введите заголовок', true);
    const r = await api('POST', wsUrl('/github/pulls'), { title, head: $('#github-panel').dataset.branch });
    toast(`PR #${r.number} создан`);
    return loadGitHub();
  }
  if (t.dataset.merge) {
    const method = prompt('Способ слияния: squash | merge | rebase', 'squash');
    if (!method) return;
    await api('POST', wsUrl(`/github/pulls/${t.dataset.merge}/merge`), { method });
    toast(`PR #${t.dataset.merge} слит`);
    loadGitHub();
  }
});

/* ---------------- Modals ---------------- */
function modal(title, html) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  $('#modal').classList.remove('hidden');
  return $('#modal-body');
}
const closeModal = () => $('#modal').classList.add('hidden');
$('#modal-close').onclick = closeModal;
$('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };

$('#new-ws-btn').onclick = () => openNewWorkspace();
function openNewWorkspace() {
  const body = modal('Репозиторий', `
    <fieldset><legend>Клонировать с GitHub</legend>
      <label>URL репозитория<input id="nw-url" placeholder="https://github.com/owner/repo.git"></label>
      <label>Ветка (необязательно)<input id="nw-branch" placeholder="main"></label>
      <div class="row" style="margin-top:10px"><button class="btn primary" id="nw-clone">Клонировать</button><button class="btn" id="nw-mine">Мои репозитории с GitHub</button></div>
      <div id="nw-repos" style="margin-top:8px"></div>
    </fieldset>
    <fieldset><legend>Новый пустой проект</legend>
      <label>Имя<input id="nw-name" placeholder="my-project"></label>
      <button class="btn" id="nw-create" style="margin-top:10px">Создать (git init)</button>
    </fieldset>
    <div id="nw-status" class="muted"></div>`);
  const done = async (name) => { closeModal(); state.workspace = name; await loadWorkspaces(); toast(`Репозиторий ${name} готов`); };
  body.onclick = guard(async (e) => {
    const status = $('#nw-status');
    if (e.target.id === 'nw-clone') {
      const url = $('#nw-url').value.trim();
      if (!url) return;
      status.textContent = 'Клонирование…';
      try { const r = await api('POST', '/api/workspaces', { cloneUrl: url, branch: $('#nw-branch').value.trim() || undefined }); await done(r.name); }
      catch (err) { status.textContent = ''; throw err; }
    }
    if (e.target.id === 'nw-create') {
      const r = await api('POST', '/api/workspaces', { name: $('#nw-name').value.trim() });
      await done(r.name);
    }
    if (e.target.id === 'nw-mine') {
      const repos = await api('GET', '/api/github/repos');
      $('#nw-repos').innerHTML = `<div class="repo-list">${repos.map((r) => `<div data-url="${esc(r.clone_url)}">${r.private ? '🔒' : '📦'} ${esc(r.full_name)} <span class="muted small-text">${esc(r.description || '')}</span></div>`).join('')}</div>`;
    }
    const pick = e.target.closest('[data-url]');
    if (pick) $('#nw-url').value = pick.dataset.url;
  });
}

$('#settings-btn').onclick = guard(async () => {
  const [s, providers, mcp] = await Promise.all([api('GET', '/api/settings'), api('GET', '/api/providers'), api('GET', '/api/mcp')]);
  const body = modal('Настройки', `
    <fieldset><legend>LLM — бесплатный провайдер (OpenAI-совместимый API)</legend>
      <label>Провайдер<select id="st-provider">${Object.entries(providers).map(([k, p]) => `<option value="${k}" ${k === s.llm.provider ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select></label>
      <div class="small-text muted" id="st-keyurl"></div>
      <label>Base URL<input id="st-base" value="${esc(s.llm.baseUrl)}"></label>
      <label>API key<input id="st-key" type="password" value="${esc(s.llm.apiKey)}" placeholder="вставьте ключ"></label>
      <label>Модель<input id="st-model" list="st-models" value="${esc(s.llm.model)}"><datalist id="st-models"></datalist></label>
      <label>Запасные модели при лимитах (через запятую)<input id="st-fallback" value="${esc((s.llm.fallbackModels || []).join(', '))}"></label>
      <div class="row"><label style="flex:1">Контекстное окно (токены)<input id="st-ctx" type="number" value="${s.llm.contextWindow}"></label><label style="flex:1">Max output tokens<input id="st-maxtok" type="number" value="${s.llm.maxTokens}"></label></div>
      <div class="row" style="margin-top:10px"><button class="btn" id="st-test">Проверить соединение</button><span id="st-test-res" class="small-text"></span></div>
    </fieldset>
    <fieldset><legend>GitHub</legend>
      <label>Personal access token (repo, pull requests, issues)<input id="st-gh" type="password" value="${esc(s.github.token)}" placeholder="github_pat_…"></label>
      <div class="row"><label style="flex:1">Имя автора коммитов<input id="st-gname" value="${esc(s.github.gitUserName)}"></label><label style="flex:1">Email<input id="st-gmail" value="${esc(s.github.gitUserEmail)}"></label></div>
      <label>Webhook secret (для @codeagent в issues/PR)<input id="st-whs" type="password" value="${esc(s.github.webhookSecret)}"></label>
      <label>Фраза-триггер<input id="st-trigger" value="${esc(s.github.triggerPhrase)}"></label>
      <div class="small-text muted">Webhook URL: <code>${esc(location.origin)}/api/github/webhook</code> (события: Issues, Issue comments, Pull request review comments)</div>
    </fieldset>
    <fieldset><legend>Агент</legend>
      <label>Режим по умолчанию<select id="st-mode">${['plan', 'ask', 'acceptEdits', 'auto'].map((m) => `<option ${m === s.agent.defaultMode ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
      <div class="row"><label style="flex:1">Макс. шагов за запрос<input id="st-turns" type="number" value="${s.agent.maxTurns}"></label><label style="flex:1">Таймаут bash, сек<input id="st-bto" type="number" value="${s.agent.bashTimeoutSec}"></label></div>
      <label>Команды без подтверждения (по одной в строке, префиксы)<textarea id="st-allowed" rows="4">${esc(s.agent.allowedCommands.join('\n'))}</textarea></label>
      <label>Запрещённые фрагменты команд<textarea id="st-denied" rows="2">${esc(s.agent.deniedCommands.join('\n'))}</textarea></label>
    </fieldset>
    <fieldset><legend>MCP-серверы и хуки (JSON)</legend>
      <label>mcpServers — как .mcp.json в Claude Code<textarea id="st-mcp" rows="5" class="mono">${esc(JSON.stringify(s.mcpServers, null, 2))}</textarea></label>
      <div class="small-text muted">${mcp.map((m) => `${m.running ? '🟢' : '🔴'} ${esc(m.name)}: ${m.tools.length} tools`).join(' · ') || 'MCP-серверы не запущены'}</div>
      <label>hooks (PreToolUse / PostToolUse / Stop)<textarea id="st-hooks" rows="5" class="mono">${esc(JSON.stringify(s.hooks, null, 2))}</textarea></label>
    </fieldset>
    <div class="row"><div class="spacer"></div><button class="btn primary" id="st-save">Сохранить</button></div>`);

  const fillProvider = (key, reset) => {
    const p = providers[key];
    $('#st-models').innerHTML = (p.models || []).map((m) => `<option value="${esc(m)}">`).join('');
    $('#st-keyurl').innerHTML = p.keyUrl ? `Получить бесплатный ключ: <a href="${esc(p.keyUrl)}" target="_blank" rel="noopener">${esc(p.keyUrl)}</a>` : '';
    if (reset) { $('#st-base').value = p.baseUrl; $('#st-model').value = p.model; }
  };
  fillProvider(s.llm.provider, false);
  $('#st-provider').onchange = (e) => fillProvider(e.target.value, true);

  const collect = () => {
    const lines = (id) => $(id).value.split('\n').map((x) => x.trim()).filter(Boolean);
    let mcpServers, hooks;
    try { mcpServers = JSON.parse($('#st-mcp').value || '{}'); hooks = JSON.parse($('#st-hooks').value || '{}'); }
    catch { throw new Error('Некорректный JSON в MCP / hooks'); }
    return {
      llm: {
        provider: $('#st-provider').value, baseUrl: $('#st-base').value.trim(), apiKey: $('#st-key').value.trim(), model: $('#st-model').value.trim(),
        fallbackModels: $('#st-fallback').value.split(',').map((x) => x.trim()).filter(Boolean),
        contextWindow: Number($('#st-ctx').value) || 64000, maxTokens: Number($('#st-maxtok').value) || 8192,
      },
      github: { token: $('#st-gh').value.trim(), gitUserName: $('#st-gname').value.trim(), gitUserEmail: $('#st-gmail').value.trim(), webhookSecret: $('#st-whs').value.trim(), triggerPhrase: $('#st-trigger').value.trim() || '@codeagent' },
      agent: { defaultMode: $('#st-mode').value, maxTurns: Number($('#st-turns').value) || 60, bashTimeoutSec: Number($('#st-bto').value) || 120, allowedCommands: lines('#st-allowed'), deniedCommands: lines('#st-denied') },
      mcpServers, hooks,
    };
  };
  const save = async () => { state.settings = await api('PUT', '/api/settings', collect()); updateModelBadge(); };
  body.onclick = guard(async (e) => {
    if (e.target.id === 'st-save') { await save(); closeModal(); toast('Настройки сохранены'); }
    if (e.target.id === 'st-test') {
      await save();
      const res = $('#st-test-res');
      res.textContent = 'Проверка…';
      try { const r = await api('POST', '/api/llm/test'); res.textContent = `✓ ${r.model} ответила «${r.reply.trim().slice(0, 40)}» за ${r.ms} мс`; res.style.color = 'var(--green)'; }
      catch (err) { res.textContent = '✕ ' + err.message; res.style.color = 'var(--red)'; }
    }
  });
});

boot();
