import { esc, markdown, renderDiff, splitDiff } from './md.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const icon = (name, cls = '') => `<svg class="i ${cls}"><use href="#i-${name}"/></svg>`;
const narrow = matchMedia('(max-width: 1000px)');

const state = {
  workspace: localStorage.getItem('ca.ws') || '',
  session: null,
  running: false,
  mode: 'ask',
  es: null,
  commands: [],
  current: null, // streaming assistant bubble
  cards: new Map(), // tool call id -> card element
  openFile: null,
  settings: null,
  stage: -1, // furthest pipeline stage reached in the current run
  pendingPerm: null,
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

function notify(title, body) {
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body, icon: '/icon.svg' }); } catch { /* some mobile browsers only allow SW notifications */ }
  }
}

/* ---------------- Theme ---------------- */
$('#theme-btn').onclick = () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  $('meta[name="theme-color"]').content = next === 'light' ? '#FFFFFF' : '#15171C';
  try { localStorage.setItem('ca.theme', next); } catch { /* private mode */ }
};

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
const logout = guard(async () => { await api('POST', '/api/logout'); location.reload(); });
$('#logout-btn').onclick = logout;
$('#logout-btn-m').onclick = logout;

/* ---------------- Boot ---------------- */
async function boot() {
  try { await api('GET', '/api/me'); } catch { return; }
  $('#app').classList.remove('hidden');
  state.settings = await api('GET', '/api/settings');
  setMode(state.settings.agent.defaultMode);
  updateModelBadge();
  if (!state.settings.llm.apiKey && state.settings.llm.provider !== 'ollama') {
    toast('Укажите API-ключ бесплатного LLM-провайдера в настройках');
  }
  await loadWorkspaces();
}

function updateModelBadge() {
  $('#model-badge').textContent = `${state.settings.llm.provider} · ${state.settings.llm.model}`;
}

async function loadWorkspaces() {
  const list = await api('GET', '/api/workspaces');
  const sel = $('#ws-select');
  sel.innerHTML = list.length ? list.map((w) => `<option value="${esc(w.name)}">${esc(w.name)}</option>`).join('') : '<option value="">Нет репозиториев</option>';
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

/* ---------------- Modes ---------------- */
function setMode(mode) {
  state.mode = mode;
  $$('#modes button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
}
$('#modes').onclick = guard(async (e) => {
  const b = e.target.closest('[data-mode]');
  if (!b) return;
  setMode(b.dataset.mode);
  if (state.session) await api('PATCH', `/api/sessions/${state.session.id}`, { mode: b.dataset.mode });
});

/* ---------------- Sessions ---------------- */
async function loadSessions() {
  const list = await api('GET', `/api/sessions?workspace=${enc(state.workspace)}`);
  $('#session-list').innerHTML = list.map((s) => `
    <li data-id="${s.id}" class="${state.session?.id === s.id ? 'active' : ''}">
      ${icon(s.source === 'github' ? 'github' : 'chat', 'sm')}
      <span class="title" title="${esc(s.title)}">${esc(s.title)}</span>
      <button class="icon-btn sm del" data-del="${s.id}" aria-label="Удалить сессию">${icon('close', 'sm')}</button>
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
  if (li) { openSession(li.dataset.id); closeDrawer(); }
});

$('#new-session-btn').onclick = guard(async () => {
  if (!state.workspace) return openNewWorkspace();
  const s = await api('POST', '/api/sessions', { workspace: state.workspace, mode: state.mode });
  await loadSessions();
  await openSession(s.id);
  closeDrawer();
  $('#input').focus();
});

function closeSession() {
  state.es?.close();
  state.es = null;
  state.session = null;
  state.cards.clear();
  state.current = null;
  state.pendingPerm = null;
  $('#messages').innerHTML = '';
  $('#messages').append(emptyState);
  $('#todos').classList.add('hidden');
  renderStages(-1);
  setRunning(false);
}
const emptyState = $('#empty-state');

async function openSession(id) {
  closeSession();
  const s = await api('GET', `/api/sessions/${id}`);
  state.session = s;
  localStorage.setItem('ca.session.' + state.workspace, id);
  $$('#session-list li').forEach((li) => li.classList.toggle('active', li.dataset.id === id));
  setMode(s.mode);
  renderHistory(s);
  renderTodos(s.todos);
  connectEvents(id);
  setRunning(s.status.running);
}

function renderHistory(s) {
  const box = $('#messages');
  box.innerHTML = '';
  let msgs = s.messages;
  const lastUser = msgs.findLastIndex((m) => m.role === 'user');
  if (s.status?.running) {
    // The SSE stream replays the current run (from its user message on), so render only what came before it.
    msgs = msgs.slice(0, Math.max(lastUser, 0));
  }
  if (!msgs.length && !s.status?.running) box.append(emptyState);
  for (const m of msgs) {
    if (m.role === 'user') {
      if (String(m.content).startsWith('[Summary of the earlier conversation')) addNote('Контекст был сжат. Краткое содержание:\n' + m.content.split('\n').slice(1).join('\n'));
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
  // Pipeline of the last completed run.
  if (!s.status?.running && lastUser >= 0) {
    state.stage = -1;
    for (const m of s.messages.slice(lastUser)) for (const c of m.tool_calls || []) advanceStage(c.function.name, false);
    renderStages(state.stage, false);
  }
  scrollDown(true);
}

/* ---------------- Pipeline stages ---------------- */
const STAGES = ['Понять', 'План', 'Правки', 'Проверка', 'Pull Request'];
const STAGE_OF = {
  todo_write: 1,
  write_file: 2, edit_file: 2, multi_edit: 2, git_branch: 2, git_merge: 2,
  bash: 3, git_diff: 3, github_ci_status: 3,
  git_commit: 4, git_push: 4, github_create_pr: 4, github_merge_pr: 4, github_review_pr: 4, github_comment: 4,
};
function advanceStage(toolName, render = true) {
  const st = STAGE_OF[toolName] ?? 0;
  if (st > state.stage) { state.stage = st; if (render) renderStages(st, true); }
}

function renderStages(current, running = state.running) {
  const nav = $('#stages');
  if (current < 0) { nav.classList.add('hidden'); return; }
  nav.classList.remove('hidden');
  const finished = !running;
  const cls = (i) => (i < current || (finished && i === current) ? 'done' : i === current ? 'current' : '');
  const full = STAGES.map((name, i) => {
    const c = cls(i);
    const link = i ? `<span class="stage-link ${i <= current ? (c === 'current' ? 'current' : 'done') : ''}"></span>` : '';
    return `${link}<span class="stage ${c}${c === 'current' && running ? ' running' : ''}"><span class="dot">${c === 'done' ? icon('check', 'sm') : ''}</span>${name}</span>`;
  }).join('');
  const label = finished ? 'Готово' : STAGES[current];
  nav.innerHTML = `${full}
    <div class="stages-compact" aria-label="Этап ${current + 1} из 5: ${label}">
      <div class="bars">${STAGES.map((_, i) => `<span class="${cls(i)}"></span>`).join('')}</div>
      <div class="lbl"><b>${label}</b><span>${Math.min(current + 1, 5)} из 5</span></div>
    </div>`;
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
      state.stage = 0;
      renderStages(0, true);
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
    case 'tool_call': addToolCard(ev, true); advanceStage(ev.name); break;
    case 'tool_progress': {
      const card = state.cards.get(ev.id);
      if (card) {
        const pre = card.querySelector('pre.live') || card.querySelector('.tbody').appendChild(Object.assign(document.createElement('pre'), { className: 'out live' }));
        pre.textContent += ev.chunk;
        pre.scrollTop = pre.scrollHeight;
      }
      break;
    }
    case 'tool_result': finishToolCard(ev); if (ev.display?.type === 'diff') refreshGit(); break;
    case 'permission_request': showPermission(ev); break;
    case 'permission_resolved':
      $(`.perm[data-req="${ev.requestId}"]`)?.remove();
      if (state.pendingPerm?.requestId === ev.requestId) state.pendingPerm = null;
      break;
    case 'todos': renderTodos(ev.todos); break;
    case 'usage': $('#usage').textContent = `↑${fmt(ev.prompt_tokens)} ↓${fmt(ev.completion_tokens)}`; break;
    case 'compacted': addNote('Контекст сжат: старые сообщения заменены кратким содержанием.'); break;
    case 'hook': if (ev.code !== 0) addNote(`Hook ${ev.event}: ${ev.command} → exit ${ev.code}\n${ev.stderr || ev.stdout}`); break;
    case 'error': addNote(ev.message, true); break;
    case 'mode': setMode(ev.mode); toast('Режим: ' + $(`#modes [data-mode="${ev.mode}"] .full`).textContent); break;
    case 'cleared': openSession(state.session.id); break;
    case 'done':
      if (state.current) state.current.el.classList.remove('cursor');
      state.current = null;
      state.pendingPerm = null;
      setRunning(false);
      renderStages(state.stage, false);
      loadSessions();
      refreshGit();
      loadTree(true);
      if (state.openFile) openFile(state.openFile, true);
      if (!$('.tab-body[data-tab="changes"]').classList.contains('hidden')) loadDiff();
      notify('CodeAgent закончил', state.session?.title || '');
      break;
  }
  scrollDown();
}

const fmt = (n) => (n > 9999 ? (n / 1000).toFixed(1) + 'k' : n);

function setRunning(r) {
  state.running = r;
  $('#stop-btn').classList.toggle('hidden', !r);
  $('#send-btn').classList.toggle('hidden', r);
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

const TOOL_ICONS = {
  read_file: 'file', write_file: 'edit', edit_file: 'edit', multi_edit: 'edit', list_dir: 'folder', glob: 'search', grep: 'search',
  bash: 'terminal', web_fetch: 'globe', todo_write: 'list', task: 'agent',
};
function toolIcon(name) {
  if (TOOL_ICONS[name]) return TOOL_ICONS[name];
  if (name.startsWith('github_')) return 'github';
  if (name.startsWith('git_')) return 'branch';
  if (name.startsWith('mcp__')) return 'plug';
  return 'terminal';
}
function toolSummary(name, args) {
  if (!args || typeof args !== 'object') return '';
  return args.command || args.path || args.pattern || args.url || args.message || args.title || args.description || args.name || (args.number ? '#' + args.number : '') || args.prompt?.slice(0, 80) || '';
}

function addToolCard(ev, live = false) {
  const card = document.createElement('details');
  card.className = 'tool';
  card.innerHTML = `<summary><span class="ticon">${icon(toolIcon(ev.name), 'sm')}</span><span class="tname">${esc(ev.name)}</span><span class="tsum">${esc(ev.summary || toolSummary(ev.name, ev.args))}</span><span class="status ${live ? 'running' : ''}"></span></summary>
    <div class="tbody"><div class="label">Аргументы</div><pre class="out">${esc(JSON.stringify(ev.args, null, 2))}</pre></div>`;
  $('#messages').append(card);
  state.cards.set(ev.id, card);
  return card;
}

function finishToolCard(ev) {
  const card = state.cards.get(ev.id);
  if (!card) return;
  const st = card.querySelector('.status');
  st.className = 'status ' + (ev.isError ? 'err' : 'ok');
  st.innerHTML = ev.isError ? 'ошибка' : icon('check', 'sm');
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
  body.insertAdjacentHTML('beforeend', '<div class="label">Результат</div>');
  body.append(out);
  if (ev.isError) card.open = true;
  if (ev.name === 'todo_write') card.open = false;
}

const PERM_TITLES = { exec: 'Выполнить команду?', edit: 'Изменить файлы?', remote: 'Действие на GitHub?', network: 'Обратиться к сети?' };

function showPermission(ev) {
  const card = state.cards.get(ev.id) || addToolCard(ev, true);
  card.open = true;
  const preview = ev.args.command || (ev.args.content !== undefined ? `${ev.args.path}\n\n${ev.args.content}` : ev.args.old_string !== undefined ? `${ev.args.path}\n- ${ev.args.old_string}\n+ ${ev.args.new_string}` : JSON.stringify(ev.args, null, 2));
  const div = document.createElement('div');
  div.className = 'perm';
  div.dataset.req = ev.requestId;
  div.innerHTML = `<div class="q">${PERM_TITLES[ev.kind] || 'Разрешить действие?'} <span class="mono">${esc(ev.name)}</span></div>
    <pre>${esc(String(preview).slice(0, 5000))}</pre>
    <label class="sr-only" for="fb-${ev.requestId}">Комментарий при отказе</label>
    <input id="fb-${ev.requestId}" placeholder="Комментарий для агента при отказе (необязательно)">
    <div class="row">
      <button class="btn primary" data-d="allow">Разрешить</button>
      <button class="btn" data-d="deny">Отклонить</button>
      <button class="btn ghost" data-d="always">Всегда для ${esc(ev.name)}</button>
    </div>
    <div class="keys"><kbd>Y</kbd> разрешить · <kbd>A</kbd> всегда · <kbd>N</kbd> отклонить</div>`;
  div.onclick = (e) => { const d = e.target.closest('[data-d]')?.dataset.d; if (d) answerPermission(ev.requestId, d); };
  card.append(div);
  state.pendingPerm = ev;
  if (narrow.matches) showView('chat');
  scrollDown(true);
  notify('CodeAgent ждёт разрешения', `${ev.name}: ${String(preview).slice(0, 80)}`);
}

const answerPermission = guard(async (requestId, decision) => {
  const div = $(`.perm[data-req="${requestId}"]`);
  await api('POST', `/api/sessions/${state.session.id}/permission`, { requestId, decision, feedback: div?.querySelector('input').value || '' });
  div?.remove();
  if (state.pendingPerm?.requestId === requestId) state.pendingPerm = null;
});

function renderTodos(todos) {
  const box = $('#todos');
  if (!todos?.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const mark = { pending: '○', in_progress: '▸', completed: '✓' };
  box.innerHTML = `<div class="head">План · ${todos.filter((t) => t.status === 'completed').length}/${todos.length}</div>` +
    todos.map((t) => `<div class="t ${t.status}"><span>${mark[t.status] || '○'}</span><span>${esc(t.content)}</span></div>`).join('');
}

/* ---------------- Keyboard shortcuts ---------------- */
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    showView('chat');
    input.focus();
    if (!input.value) { input.value = '/'; updateCmdMenu(); }
    return;
  }
  if (e.key === 'Escape' && !$('#modal').classList.contains('hidden')) { closeModal(); return; }
  if (e.key === 'Escape' && state.running && document.activeElement !== input) { $('#stop-btn').click(); return; }
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if (!state.pendingPerm || typing || e.ctrlKey || e.metaKey || e.altKey) return;
  const d = { y: 'allow', a: 'always', n: 'deny' }[e.key.toLowerCase()];
  if (d) { e.preventDefault(); answerPermission(state.pendingPerm.requestId, d); }
});

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
  // On phones Enter inserts a newline; the send button submits.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !narrow.matches) { e.preventDefault(); $('#composer').requestSubmit(); }
});

function updateCmdMenu() {
  const menu = $('#cmd-menu');
  const m = input.value.match(/^\/([\w:-]*)$/);
  if (!m) { menu.classList.add('hidden'); return; }
  const items = state.commands.filter((c) => c.name.startsWith(m[1]));
  if (!items.length) { menu.classList.add('hidden'); return; }
  menu.innerHTML = items.map((c, i) => `<div role="option" data-name="${esc(c.name)}" class="${i === 0 ? 'sel' : ''}"><b>/${esc(c.name)}</b><span class="muted">${esc(c.description)}${c.builtin ? '' : ' (своя)'}</span></div>`).join('');
  menu.classList.remove('hidden');
}
function pickCmd(name) { input.value = `/${name} `; $('#cmd-menu').classList.add('hidden'); input.focus(); }
$('#cmd-menu').onclick = (e) => { const d = e.target.closest('[data-name]'); if (d) pickCmd(d.dataset.name); };

function sendText(text) { input.value = text; showView('chat'); $('#composer').requestSubmit(); }

$('#composer').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || state.running) return;
  if (!state.workspace) return openNewWorkspace();
  if (!state.session) {
    const s = await api('POST', '/api/sessions', { workspace: state.workspace, mode: state.mode });
    await loadSessions();
    await openSession(s.id);
  }
  input.value = '';
  input.style.height = 'auto';
  $('#cmd-menu').classList.add('hidden');
  emptyState.remove();
  await api('POST', `/api/sessions/${state.session.id}/messages`, { text, mode: state.mode });
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}));

$('#stop-btn').onclick = guard(() => api('POST', `/api/sessions/${state.session.id}/stop`));
$('#messages').addEventListener('click', (e) => {
  const s = e.target.closest('.suggest');
  if (s) { input.value = s.dataset.prompt; input.focus(); updateCmdMenu(); }
});

/* Voice input (Web Speech API, where the browser supports it) */
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (Recognition) {
  const btn = $('#voice-btn');
  btn.classList.remove('hidden');
  let rec = null;
  btn.onclick = () => {
    if (rec) { rec.stop(); return; }
    rec = new Recognition();
    rec.lang = 'ru-RU';
    rec.interimResults = true;
    const base = input.value ? input.value.trimEnd() + ' ' : '';
    rec.onresult = (e) => { input.value = base + [...e.results].map((r) => r[0].transcript).join(''); input.dispatchEvent(new Event('input')); };
    rec.onend = () => { rec = null; btn.classList.remove('on'); };
    rec.onerror = (e) => toast('Голосовой ввод: ' + e.error, true);
    btn.classList.add('on');
    rec.start();
  };
}

/* ---------------- File tree & viewer ---------------- */
async function loadTree(keepOpen = false) {
  if (!state.workspace) return;
  const box = $('#file-tree');
  const opened = keepOpen ? [...box.querySelectorAll('.node.dir.open')].map((n) => n.dataset.path) : [];
  box.innerHTML = '';
  await renderDir(box, '.');
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
    n.tabIndex = 0;
    n.innerHTML = it.dir ? `<span class="caret">▸</span>${icon('folder', 'sm')}<span>${esc(it.name)}</span>` : `<span class="caret"></span>${icon('file', 'sm')}<span>${esc(it.name)}</span>`;
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
  n.querySelector('.caret').textContent = open ? '▾' : '▸';
  if (open && !ch.childElementCount) await renderDir(ch, n.dataset.path);
}

const onTreeActivate = guard(async (e) => {
  const n = e.target.closest('.node');
  if (!n) return;
  if (n.classList.contains('dir')) return toggleDir(n);
  $$('#file-tree .node.active').forEach((x) => x.classList.remove('active'));
  n.classList.add('active');
  await openFile(n.dataset.path);
  showRight('file');
  closeDrawer();
});
$('#file-tree').onclick = onTreeActivate;
$('#file-tree').onkeydown = (e) => { if (e.key === 'Enter') onTreeActivate(e); };
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

/* ---------------- Panels & mobile navigation ---------------- */
function showRight(tab) {
  $('.layout').classList.remove('no-right');
  $$('.tabs button[role="tab"]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab-body').forEach((b) => b.classList.toggle('hidden', b.dataset.tab !== tab));
  $$('#bottom-nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === tab || (tab === 'file' && b.dataset.view === 'files')));
  if (tab === 'changes') loadDiff();
  if (tab === 'git') refreshGit();
  if (tab === 'github') loadGitHub();
}
$$('.tabs button[role="tab"]').forEach((b) => { b.onclick = () => showRight(b.dataset.tab); });

function openDrawer() { $('#left').classList.add('open'); $('#scrim').classList.add('show'); }
function closeDrawer() { $('#left').classList.remove('open'); $('#scrim').classList.remove('show'); }
$('#toggle-left').onclick = () => ($('#left').classList.contains('open') ? closeDrawer() : openDrawer());
$('#scrim').onclick = closeDrawer;
$('#toggle-right').onclick = () => $('.layout').classList.toggle('no-right');
$('#close-right').onclick = () => showView('chat');

function showView(view) {
  if (!narrow.matches) { if (view !== 'chat' && view !== 'files') showRight(view); return; }
  closeDrawer();
  if (view === 'chat') {
    $('.layout').classList.add('no-right');
    $$('#bottom-nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === 'chat'));
  } else if (view === 'files') {
    if (state.openFile) showRight('file'); else openDrawer();
    $$('#bottom-nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === 'files'));
  } else showRight(view);
}
$('#bottom-nav').onclick = (e) => { const b = e.target.closest('[data-view]'); if (b) showView(b.dataset.view); };
if (narrow.matches) $('.layout').classList.add('no-right');
narrow.addEventListener('change', (e) => { if (e.matches) showView('chat'); });

/* ---------------- Changes: review per file ---------------- */
async function loadDiff() {
  const { diff } = await api('GET', wsUrl('/diff'));
  const files = splitDiff(diff);
  let add = 0, del = 0;
  $('#diff-view').innerHTML = files.length
    ? files.map((f) => {
      const lines = f.diff.split('\n');
      const a = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
      const d = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
      add += a; del += d;
      return `<div class="diff-file"><div class="fhead"><span class="fname">${esc(f.file)}</span><span class="stat"><span class="a">+${a}</span><span class="d">−${d}</span></span>
        <button class="btn sm" data-reject="${esc(f.file)}">Отклонить</button></div>${renderDiff(lines.slice(Math.max(lines.findIndex((l) => l.startsWith('@@')), 0)).join('\n'))}</div>`;
    }).join('')
    : '<p class="muted" style="padding:0 4px">Нет незакоммиченных изменений.</p>';
  $('#changes-summary').textContent = files.length ? `${files.length} файл(ов) · +${add} −${del}` : 'Незакоммиченные изменения';
  $('#changes-bar').classList.toggle('hidden', !files.length);
}
$('#refresh-diff').onclick = guard(() => loadDiff());
$('#diff-view').onclick = guard(async (e) => {
  const file = e.target.closest('[data-reject]')?.dataset.reject;
  if (!file || !confirm(`Отменить изменения в ${file}?`)) return;
  await api('POST', wsUrl('/git'), { action: 'discard-file', file });
  toast(`Изменения в ${file} отменены`);
  loadDiff();
  refreshGit();
  loadTree(true);
});
$('#changes-accept').onclick = () => sendText('/commit');
$('#changes-review').onclick = () => sendText('/review');

async function refreshGit() {
  if (!state.workspace) return;
  const g = await api('GET', wsUrl('/git')).catch(() => null);
  if (!g) return;
  $('#branch-badge').innerHTML = g.branch ? `${icon('branch', 'sm')}${esc(g.branch)}` : '';
  $('#changes-count').textContent = g.files.length || '';
  $('#changes-dot').classList.toggle('hidden', !g.files.length);
  const panel = $('#git-panel');
  const local = g.branches.filter((b) => !b.name.startsWith('origin'));
  panel.innerHTML = `
    <div class="row"><span class="chip mono">${icon('branch', 'sm')}${esc(g.branch || '—')}</span><span class="muted mono" style="font-size:12px">${esc(g.tracking)}</span></div>
    <h3>Ветки</h3>
    <div class="row">
      <label class="sr-only" for="git-branch-sel">Ветка</label>
      <select id="git-branch-sel">${local.map((b) => `<option ${b.current ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>
      <button class="btn sm" data-git="checkout">Переключить</button>
      <button class="btn sm" data-git="create-branch">Новая ветка</button>
      <button class="btn sm" data-git="merge">Слить в текущую…</button>
    </div>
    <h3>Синхронизация</h3>
    <div class="row">
      <button class="btn sm" data-git="pull">Pull</button>
      <button class="btn sm" data-git="push">Push</button>
      <button class="btn sm" data-git="fetch">Fetch</button>
    </div>
    <h3>Изменённые файлы · ${g.files.length}</h3>
    ${g.files.map((f) => `<div class="file" data-file="${esc(f.path)}"><span class="st">${esc(f.status)}</span>${esc(f.path)}</div>`).join('') || '<div class="muted">Рабочее дерево чистое</div>'}
    ${g.files.length ? `<div class="row" style="margin-top:10px"><label class="sr-only" for="commit-msg">Сообщение коммита</label><input id="commit-msg" placeholder="Сообщение коммита" style="flex:1;min-width:160px"><button class="btn sm primary" data-git="commit">Commit</button></div>
    <div class="row" style="margin-top:8px"><button class="btn sm" id="ask-commit">${icon('agent', 'sm')}Агент: /commit</button><button class="btn sm danger" data-git="discard">Откатить всё</button></div>` : ''}
    <h3>История</h3>
    <div class="log">${esc(g.log.join('\n')) || '<span class="muted">нет коммитов</span>'}</div>`;
}

$('#git-panel').onclick = guard(async (e) => {
  const f = e.target.closest('[data-file]');
  if (f) return showRight('changes');
  if (e.target.closest('#ask-commit')) return sendText('/commit');
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
      <div class="row"><b>${esc(prs.repo)}</b><div class="spacer"></div><a href="https://github.com/${esc(prs.repo)}" target="_blank" rel="noopener">Открыть на GitHub</a></div>
      <h3>Новый pull request из ${esc(g.branch)}</h3>
      <div class="row"><label class="sr-only" for="pr-title">Заголовок PR</label><input id="pr-title" placeholder="Заголовок PR" style="flex:1;min-width:160px"><button class="btn sm primary" id="pr-create">Создать</button></div>
      <div class="row" style="margin-top:8px"><button class="btn sm" id="pr-agent">${icon('agent', 'sm')}Агент: ветка, коммит, push, PR</button></div>
      <h3>Pull requests · ${prs.items.length}</h3>
      ${prs.items.map((p) => `<div class="item"><div class="grow"><a href="${esc(p.url)}" target="_blank" rel="noopener">#${p.number} ${esc(p.title)}</a><div class="sub">${esc(p.head)} → ${esc(p.base)} · ${esc(p.user)}${p.draft ? ' · черновик' : ''}</div></div>
        <button class="btn sm" data-review="${p.number}">Ревью</button><button class="btn sm accept" data-merge="${p.number}">Merge</button></div>`).join('') || '<p class="muted">Нет открытых PR</p>'}
      <h3>Issues · ${issues.items.length}</h3>
      ${issues.items.map((i) => `<div class="item"><div class="grow"><a href="${esc(i.url)}" target="_blank" rel="noopener">#${i.number} ${esc(i.title)}</a><div class="sub">${esc(i.user)}</div></div>
        <button class="btn sm primary" data-fix="${i.number}">Исправить</button></div>`).join('') || '<p class="muted">Нет открытых issues</p>'}`;
    panel.dataset.branch = g.branch;
  } catch (e) {
    panel.innerHTML = `<p class="error-text">${esc(e.message)}</p><p class="muted">Для работы с GitHub нужен токен (Настройки) и репозиторий, склонированный с github.com.</p>`;
  }
}

$('#github-panel').onclick = guard(async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.id === 'pr-agent') return sendText('/pr');
  if (t.dataset.fix) return sendText(`/fix-issue ${t.dataset.fix}`);
  if (t.dataset.review) return sendText(`/review ${t.dataset.review}`);
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
      <div class="row" style="margin-top:12px"><button class="btn primary" id="nw-clone">Клонировать</button><button class="btn" id="nw-mine">${icon('github', 'sm')}Мои репозитории</button></div>
      <div id="nw-repos" style="margin-top:10px"></div>
    </fieldset>
    <fieldset><legend>Новый пустой проект</legend>
      <label>Имя<input id="nw-name" placeholder="my-project"></label>
      <button class="btn" id="nw-create" style="margin-top:12px">Создать (git init)</button>
    </fieldset>
    <div id="nw-status" class="muted"></div>`);
  const done = async (name) => { closeModal(); state.workspace = name; await loadWorkspaces(); toast(`Репозиторий ${name} готов`); };
  body.onclick = guard(async (e) => {
    const status = $('#nw-status');
    const id = e.target.closest('button')?.id;
    if (id === 'nw-clone') {
      const url = $('#nw-url').value.trim();
      if (!url) return;
      status.textContent = 'Клонирование…';
      try { const r = await api('POST', '/api/workspaces', { cloneUrl: url, branch: $('#nw-branch').value.trim() || undefined }); await done(r.name); }
      catch (err) { status.textContent = ''; throw err; }
    }
    if (id === 'nw-create') {
      const r = await api('POST', '/api/workspaces', { name: $('#nw-name').value.trim() });
      await done(r.name);
    }
    if (id === 'nw-mine') {
      const repos = await api('GET', '/api/github/repos');
      $('#nw-repos').innerHTML = `<div class="repo-list">${repos.map((r) => `<div data-url="${esc(r.clone_url)}"><b>${esc(r.full_name)}</b>${r.private ? ' <span class="chip">private</span>' : ''} <span class="muted">${esc(r.description || '')}</span></div>`).join('')}</div>`;
    }
    const pick = e.target.closest('[data-url]');
    if (pick) $('#nw-url').value = pick.dataset.url;
  });
}

$('#settings-btn').onclick = guard(async () => {
  const [s, providers, mcp] = await Promise.all([api('GET', '/api/settings'), api('GET', '/api/providers'), api('GET', '/api/mcp')]);
  const modeNames = { plan: 'План', ask: 'Спрашивать', acceptEdits: 'Правки сами', auto: 'Автопилот' };
  const body = modal('Настройки', `
    <fieldset><legend>Модель — бесплатный провайдер</legend>
      <label>Провайдер<select id="st-provider">${Object.entries(providers).map(([k, p]) => `<option value="${k}" ${k === s.llm.provider ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select></label>
      <div class="muted" id="st-keyurl" style="margin-top:6px;font-size:12px"></div>
      <label>Base URL<input id="st-base" value="${esc(s.llm.baseUrl)}"></label>
      <label>API-ключ<input id="st-key" type="password" value="${esc(s.llm.apiKey)}" placeholder="вставьте ключ"></label>
      <label>Модель<input id="st-model" list="st-models" value="${esc(s.llm.model)}"><datalist id="st-models"></datalist></label>
      <label>Запасные модели при лимитах (через запятую)<input id="st-fallback" value="${esc((s.llm.fallbackModels || []).join(', '))}"></label>
      <div class="row"><label style="flex:1">Контекстное окно (токены)<input id="st-ctx" type="number" value="${s.llm.contextWindow}"></label><label style="flex:1">Макс. токенов ответа<input id="st-maxtok" type="number" value="${s.llm.maxTokens}"></label></div>
      <div class="row" style="margin-top:12px"><button class="btn" id="st-test">Проверить соединение</button><span id="st-test-res" style="font-size:12px"></span></div>
    </fieldset>
    <fieldset><legend>GitHub</legend>
      <label>Personal access token (repo, pull requests, issues)<input id="st-gh" type="password" value="${esc(s.github.token)}" placeholder="github_pat_…"></label>
      <div class="row"><label style="flex:1">Имя автора коммитов<input id="st-gname" value="${esc(s.github.gitUserName)}"></label><label style="flex:1">Email<input id="st-gmail" value="${esc(s.github.gitUserEmail)}"></label></div>
      <label>Webhook secret (для @codeagent в issues и PR)<input id="st-whs" type="password" value="${esc(s.github.webhookSecret)}"></label>
      <label>Фраза-триггер<input id="st-trigger" value="${esc(s.github.triggerPhrase)}"></label>
      <div class="muted" style="margin-top:8px;font-size:12px">Webhook URL: <code>${esc(location.origin)}/api/github/webhook</code> — события Issues, Issue comments, Pull request review comments</div>
    </fieldset>
    <fieldset><legend>Агент</legend>
      <label>Режим по умолчанию<select id="st-mode">${Object.entries(modeNames).map(([m, n]) => `<option value="${m}" ${m === s.agent.defaultMode ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <div class="row"><label style="flex:1">Макс. шагов за запрос<input id="st-turns" type="number" value="${s.agent.maxTurns}"></label><label style="flex:1">Таймаут bash, сек<input id="st-bto" type="number" value="${s.agent.bashTimeoutSec}"></label></div>
      <label>Команды без подтверждения (по одной в строке, префиксы)<textarea id="st-allowed" rows="4">${esc(s.agent.allowedCommands.join('\n'))}</textarea></label>
      <label>Запрещённые фрагменты команд<textarea id="st-denied" rows="2">${esc(s.agent.deniedCommands.join('\n'))}</textarea></label>
    </fieldset>
    <fieldset><legend>MCP-серверы и хуки (JSON)</legend>
      <label>mcpServers — как .mcp.json в Claude Code<textarea id="st-mcp" rows="5" class="mono">${esc(JSON.stringify(s.mcpServers, null, 2))}</textarea></label>
      <div class="muted" style="margin-top:6px;font-size:12px">${mcp.map((m) => `${m.running ? 'работает' : 'остановлен'}: ${esc(m.name)} (${m.tools.length} инструментов)`).join(' · ') || 'MCP-серверы не запущены'}</div>
      <label>hooks (PreToolUse / PostToolUse / Stop)<textarea id="st-hooks" rows="5" class="mono">${esc(JSON.stringify(s.hooks, null, 2))}</textarea></label>
    </fieldset>
    <div class="row"><div class="spacer"></div><button class="btn primary lg" id="st-save">Сохранить</button></div>`);

  const fillProvider = (key, reset) => {
    const p = providers[key];
    $('#st-models').innerHTML = (p.models || []).map((m) => `<option value="${esc(m)}">`).join('');
    $('#st-keyurl').innerHTML = p.keyUrl ? `Бесплатный ключ: <a href="${esc(p.keyUrl)}" target="_blank" rel="noopener">${esc(p.keyUrl)}</a>` : '';
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
    const id = e.target.closest('button')?.id;
    if (id === 'st-save') { await save(); closeModal(); toast('Настройки сохранены'); }
    if (id === 'st-test') {
      await save();
      const res = $('#st-test-res');
      res.textContent = 'Проверка…';
      res.style.color = '';
      try { const r = await api('POST', '/api/llm/test'); res.textContent = `${r.model} ответила «${r.reply.trim().slice(0, 40)}» за ${r.ms} мс`; res.style.color = 'var(--ok-text)'; }
      catch (err) { res.textContent = err.message; res.style.color = 'var(--danger-text)'; }
    }
  });
});

/* ---------------- PWA ---------------- */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

boot();
