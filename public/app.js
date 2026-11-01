const state = {
  files: [], expanded: new Set(['']), directoryCache: new Map(), tabs: new Map(),
  activePath: null, selectedPath: '', createKind: 'file', activeView: 'explorer',
  activePanel: 'terminal', monaco: null, editor: null, models: new Map(), chatHistory: [], debugLines: [], termWs: null, termConnected: false,
};
const $ = (id) => document.getElementById(id);
const sideContent = $('side-content');
const createDialog = $('create-dialog');
const createName = $('create-name');

async function api(url, options = {}) {
  const response = await fetch(url, { headers: options.body ? { 'Content-Type': 'application/json' } : undefined, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}
function escapeText(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function extensionOf(filePath) { return filePath.split('/').pop().split('.').pop().toLowerCase(); }
function iconFor(entry) {
  if (entry.type === 'folder') return '▰';
  const icons = { js: 'JS', mjs: 'JS', ts: 'TS', tsx: 'TSX', jsx: 'JSX', html: '<>', css: '#', json: '{}', md: 'M', py: 'PY', cs: 'C#', txt: '≡', yml: 'Y', yaml: 'Y', svg: '◇' };
  return icons[extensionOf(entry.path)] || '·';
}
async function listDirectory(folder = '') {
  const data = await api(`/api/files?path=${encodeURIComponent(folder || '.')}`);
  state.directoryCache.set(folder, data.entries);
  return data.entries;
}
async function refreshFiles() {
  try { state.directoryCache.clear(); await listDirectory(''); await renderTree(); }
  catch (error) { notify(error.message); }
}
async function renderTree() {
  sideContent.replaceChildren();
  if (state.activeView !== 'explorer') return;
  const root = document.createElement('div');
  root.className = 'tree-root';
  root.innerHTML = `<span class="chevron">${state.expanded.has('') ? '⌄' : '›'}</span><span>workspace</span>`;
  root.addEventListener('click', async () => {
    if (state.expanded.has('')) state.expanded.delete('');
    else { state.expanded.add(''); if (!state.directoryCache.has('')) await listDirectory(''); }
    renderTree();
  });
  sideContent.append(root);
  if (!state.expanded.has('')) return;
  const children = document.createElement('div');
  children.className = 'tree-children';
  await appendEntries(children, '', state.directoryCache.get('') || []);
  if (!(state.directoryCache.get('') || []).length) {
    const empty = document.createElement('div');
    empty.className = 'empty-tree';
    empty.innerHTML = 'This folder is empty.<br><button data-create="file">Create a file</button> or <button data-create="folder">create a folder</button> to get started.';
    empty.querySelectorAll('[data-create]').forEach((button) => button.addEventListener('click', () => openCreate(button.dataset.create)));
    children.append(empty);
  }
  sideContent.append(children);
}
async function appendEntries(container, parent, entries) {
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = `tree-row ${entry.type}${state.selectedPath === entry.path ? ' selected' : ''}`;
    row.style.paddingLeft = `${14 + parent.split('/').filter(Boolean).length * 14}px`;
    row.dataset.path = entry.path;
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      state.selectedPath = entry.path;
      if (entry.type !== 'folder') renderTree();
      showCtxMenu(event.clientX, event.clientY, explorerMenuFor(entry));
    });
    row.innerHTML = `${entry.type === 'folder' ? `<span class="chevron">${state.expanded.has(entry.path) ? '⌄' : '›'}</span>` : '<span class="chevron"></span>'}<span class="tree-icon">${escapeText(iconFor(entry))}</span><span class="tree-name">${escapeText(entry.name)}</span>`;
    row.addEventListener('click', async (event) => {
      event.stopPropagation();
      state.selectedPath = entry.path;
      if (entry.type === 'folder') {
        if (state.expanded.has(entry.path)) state.expanded.delete(entry.path);
        else { state.expanded.add(entry.path); if (!state.directoryCache.has(entry.path)) { try { await listDirectory(entry.path); } catch (error) { notify(error.message); } } }
        await renderTree();
      } else { await openFile(entry.path); await renderTree(); }
    });
    container.append(row);
    if (entry.type === 'folder' && state.expanded.has(entry.path)) {
      if (!state.directoryCache.has(entry.path)) { try { await listDirectory(entry.path); } catch (error) { notify(error.message); continue; } }
      const nested = document.createElement('div');
      await appendEntries(nested, entry.path, state.directoryCache.get(entry.path) || []);
      container.append(nested);
    }
  }
}
function languageFor(filePath) {
  const extensions = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript', jsx: 'javascript', html: 'html', css: 'css', scss: 'scss', json: 'json', md: 'markdown', py: 'python', xml: 'xml', yml: 'yaml', yaml: 'yaml', sh: 'shell', ps1: 'powershell', sql: 'sql', java: 'java', cs: 'csharp', cpp: 'cpp', c: 'c', go: 'go', rs: 'rust' };
  return extensions[extensionOf(filePath)] || 'plaintext';
}
function showStatus(message, delay = 1800) {
  $('save-status').textContent = message;
  if (delay) setTimeout(() => { if ($('save-status').textContent === message) $('save-status').textContent = 'Ready'; }, delay);
}
function tabLabel(filePath) { return filePath.split('/').pop(); }
function renderTabs() {
  $('tabs').replaceChildren();
  for (const [filePath, tabState] of state.tabs) {
    const tab = document.createElement('div');
    tab.className = `tab${state.activePath === filePath ? ' active' : ''}`;
    tab.title = filePath;
    tab.innerHTML = `<span class="tree-icon">${escapeText(iconFor({ type: 'file', path: filePath }))}</span><span class="tab-name">${escapeText(tabLabel(filePath))}</span>${tabState.dirty ? '<span class="dirty-dot">●</span>' : ''}<button class="tab-close" title="Close">×</button>`;
    tab.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showCtxMenu(event.clientX, event.clientY, tabMenuFor(filePath));
    });
    tab.addEventListener('click', (event) => { if (event.target.closest('.tab-close')) { event.stopPropagation(); closeTab(filePath); } else activateTab(filePath); });
    $('tabs').append(tab);
  }
}
async function openFile(filePath) {
  if (state.tabs.has(filePath)) return activateTab(filePath);
  try {
    const file = await api(`/api/file?path=${encodeURIComponent(filePath)}`);
    const model = state.monaco.editor.createModel(file.content, languageFor(filePath), state.monaco.Uri.parse(`file:///${filePath}`));
    state.models.set(filePath, model);
    state.tabs.set(filePath, { dirty: false, model });
    model.onDidChangeContent(() => { const tab = state.tabs.get(filePath); if (tab) { tab.dirty = true; renderTabs(); showStatus('Unsaved changes', 0); } });
    activateTab(filePath);
  } catch (error) { notify(error.message); }
}
function activateTab(filePath) {
  if (!state.tabs.has(filePath)) return;
  state.activePath = filePath;
  state.editor.setModel(state.tabs.get(filePath).model);
  $('welcome').classList.add('hidden'); $('editor').classList.remove('hidden');
  $('active-title').textContent = tabLabel(filePath);
  $('breadcrumbs').innerHTML = `<span class="crumb-root">workspace</span><span class="crumb-sep">›</span>${filePath.split('/').map((part) => `<span>${escapeText(part)}</span>`).join('<span class="crumb-sep">›</span>')}`;
  $('language-status').textContent = languageFor(filePath);
  renderTabs(); updateCursorStatus();
}
function closeTab(filePath) {
  const tab = state.tabs.get(filePath);
  if (!tab) return;
  if (tab.dirty && !confirm(`Discard unsaved changes to ${tabLabel(filePath)}?`)) return;
  tab.model.dispose(); state.tabs.delete(filePath); state.models.delete(filePath);
  if (state.activePath === filePath) {
    const next = [...state.tabs.keys()].at(-1); state.activePath = null;
    if (next) activateTab(next);
    else { $('editor').classList.add('hidden'); $('welcome').classList.remove('hidden'); $('active-title').textContent = 'No file open'; $('breadcrumbs').innerHTML = '<span class="crumb-root">CodeHarbor</span><span class="crumb-sep">›</span><span>workspace</span>'; $('language-status').textContent = 'Plain Text'; }
  }
  renderTabs();
}
async function saveActive() {
  if (!state.activePath) return;
  const tab = state.tabs.get(state.activePath); if (!tab) return;
  try { await api('/api/file', { method: 'PUT', body: JSON.stringify({ path: state.activePath, content: tab.model.getValue() }) }); tab.dirty = false; renderTabs(); showStatus('Saved'); }
  catch (error) { notify(error.message); }
}
function updateCursorStatus() { const position = state.editor.getPosition(); if (position) $('cursor-status').textContent = `Ln ${position.lineNumber}, Col ${position.column}`; }
function selectedParent() {
  if (!state.selectedPath) return '';
  const item = findEntry(state.selectedPath);
  return item?.type === 'folder' ? item.path : item?.path.split('/').slice(0, -1).join('/') || '';
}
function openCreate(kind) {
  state.createKind = kind;
  $('create-title').textContent = kind === 'file' ? 'New File' : 'New Folder';
  $('create-label').textContent = kind === 'file' ? 'File name' : 'Folder name';
  $('confirm-create').textContent = kind === 'file' ? 'Create File' : 'Create Folder';
  $('create-location').textContent = selectedParent() || 'workspace';
  $('create-error').classList.add('hidden'); createName.value = ''; createDialog.showModal(); createName.focus();
}
function findEntry(filePath) { for (const entries of state.directoryCache.values()) { const found = entries.find((entry) => entry.path === filePath); if (found) return found; } return null; }
async function createEntry(event) {
  event.preventDefault();
  const name = createName.value.trim();
  if (!name || name === '.' || name === '..' || /[<>:"|?*]/.test(name) || name.includes('/') || name.includes('\\')) { $('create-error').textContent = 'Enter a valid name without a path separator.'; $('create-error').classList.remove('hidden'); return; }
  const relative = [selectedParent(), name].filter(Boolean).join('/');
  try {
    const result = await api('/api/create', { method: 'POST', body: JSON.stringify({ path: relative, kind: state.createKind }) });
    createDialog.close(); const parent = result.path.split('/').slice(0, -1).join('/'); state.expanded.add(parent); state.selectedPath = result.path;
    await refreshFiles();
    if (result.kind === 'file') await openFile(result.path); else state.expanded.add(result.path);
    await renderTree(); showStatus(`${result.kind === 'file' ? 'File' : 'Folder'} created`);
  } catch (error) { $('create-error').textContent = error.message; $('create-error').classList.remove('hidden'); }
}
function notify(message) { const item = document.createElement('div'); item.className = 'notice'; item.textContent = message; document.body.append(item); setTimeout(() => item.remove(), 3000); }
function showSearchPane() {
  $('side-heading-title').textContent = 'Search'; $('explorer-actions').classList.add('hidden');
  sideContent.innerHTML = '<div class="search-pane"><input id="search-input" placeholder="Search in files" aria-label="Search in files"><div id="search-results"></div></div>';
  const input = $('search-input');
  input.addEventListener('input', async () => {
    const query = input.value.trim(); if (!query) { $('search-results').replaceChildren(); return; }
    try {
      const { results } = await api(`/api/search?q=${encodeURIComponent(query)}`);
      $('search-results').innerHTML = results.length ? results.map((result) => `<div class="search-result" data-path="${escapeText(result.path)}"><strong>${escapeText(result.path)}</strong><small>${result.line}: ${escapeText(result.preview)}</small></div>`).join('') : '<div class="empty-tree">No results.</div>';
      $('search-results').querySelectorAll('.search-result').forEach((row) => row.addEventListener('click', () => openFile(row.dataset.path)));
    } catch (error) { notify(error.message); }
  });
  input.focus();
}
function debugAppend(text) {
  state.debugLines.push(text);
  if (state.activePanel === 'debug') {
    const el = $('panel-empty');
    el.classList.remove('hidden');
    el.textContent = state.debugLines.join('\n');
    el.scrollTop = el.scrollHeight;
  }
}
function runActiveJsFile() {
  if (!state.activePath) { notify('Open a JavaScript file first.'); return; }
  if (!state.activePath.endsWith('.js')) { notify('Active file is not JavaScript.'); return; }
  toggleTerminal(true);
  sendTerminalCommand(`node "${state.activePath}"`);
  debugAppend(`> node "${state.activePath}"`);
}
function explainLastError() {
  const out = $('terminal-output');
  const text = (out ? out.innerText : '').slice(-1500);
  if (!text.trim()) { notify('No terminal output to analyze.'); return; }
  setView('ai');
  askAiExplain(text);
}
async function askAiExplain(errorText) {
  addChatMessage('user', 'Explain this error:\n' + errorText.slice(0, 1200));
  try {
    const result = await api('/api/ai/explain-error', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: errorText }),
    });
    addChatMessage('assistant', result.content);
  } catch (error) { addChatMessage('system', error.message); }
}
function showRunPane() {
  sideContent.replaceChildren();
  const wrap = document.createElement('div');
  wrap.className = 'run-pane';
  const hint = document.createElement('div');
  hint.className = 'empty-tree';
  hint.textContent = 'Commands run in the integrated terminal. Output is mirrored to the DEBUG CONSOLE panel below.';
  const b1 = document.createElement('button'); b1.className = 'run-btn primary'; b1.textContent = 'Run Active JS File';
  b1.addEventListener('click', runActiveJsFile);
  const b2 = document.createElement('button'); b2.className = 'run-btn'; b2.textContent = 'Run PowerShell Command…';
  b2.addEventListener('click', () => { toggleTerminal(true); $('terminal-command').focus(); });
  const b3 = document.createElement('button'); b3.className = 'run-btn'; b3.textContent = 'Explain Last Error';
  b3.addEventListener('click', explainLastError);
  wrap.append(hint, b1, b2, b3);
  sideContent.append(wrap);
}
function addChatMessage(role, text) {
  const list = $('ai-messages');
  if (!list) return;
  const div = document.createElement('div');
  div.className = 'ai-message ' + role;
  div.textContent = text;
  list.append(div);
  list.scrollTop = list.scrollHeight;
}
async function chatSend(text) {
  addChatMessage('user', text);
  const history = (state.chatHistory || []).slice(-20);
  history.push({ role: 'user', content: text });
  state.chatHistory = history;
  try {
    const result = await api('/api/ai/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: history }),
    });
    state.chatHistory.push({ role: 'assistant', content: result.content });
    addChatMessage('assistant', result.content);
  } catch (error) { addChatMessage('system', error.message); }
}
function showAiPane() {
  sideContent.replaceChildren();
  const wrap = document.createElement('div');
  wrap.className = 'ai-pane';
  const status = document.createElement('div');
  status.className = 'ai-status';
  api('/api/ai/status').then((s) => { status.textContent = s.configured ? `AI ready · ${s.model}` : 'AI not configured'; })
    .catch(() => { status.textContent = 'AI status unavailable'; });
  const list = document.createElement('div'); list.className = 'ai-messages'; list.id = 'ai-messages';
  const row = document.createElement('div'); row.className = 'ai-input-row';
  const input = document.createElement('input'); input.id = 'ai-input'; input.placeholder = 'Ask about your code…'; input.autocomplete = 'off';
  const sendBtn = document.createElement('button'); sendBtn.className = 'primary'; sendBtn.textContent = 'Send';
  const explainBtn = document.createElement('button'); explainBtn.className = 'run-btn'; explainBtn.textContent = 'Explain last error';
  const doSend = () => { const v = input.value.trim(); if (!v) return; input.value = ''; chatSend(v); };
  sendBtn.addEventListener('click', doSend);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSend(); });
  explainBtn.addEventListener('click', explainLastError);
  row.append(input, sendBtn);
  wrap.append(status, list, row, explainBtn);
  sideContent.append(wrap);
}
async function setView(view) {
  state.activeView = view;
  document.querySelectorAll('.activity').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  $('side-heading-title').textContent = ({ explorer: 'Explorer', search: 'Search', source: 'Source Control', run: 'Run and Debug', extensions: 'Extensions', ai: 'AI Assistant', settings: 'Settings' })[view] || 'Explorer';
  $('explorer-actions').classList.toggle('hidden', view !== 'explorer');
  if (view === 'search') showSearchPane();
  else if (view === 'explorer') renderTree();
  else {
    sideContent.replaceChildren();
    const message = document.createElement('div'); message.className = 'empty-tree';
    if (view === 'source') {
      try {
        const git = await api('/api/git');
        if (!git.repository) message.textContent = 'No Git repository found in this workspace.';
        else message.textContent = `${git.branch || 'Detached HEAD'} · ${git.changes} changed file${git.changes === 1 ? '' : 's'}`;
      } catch (error) { message.textContent = error.message; }
    } else if (view === 'run') { showRunPane(); }
    else if (view === 'ai') { showAiPane(); }
    else if (view === 'extensions') {
      message.innerHTML = 'Full extension marketplace is available in the built-in IDE.<br><button class="run-btn primary" id="open-full-ide">Open Full IDE (code-server)</button>';
      const btn = message.querySelector('#open-full-ide');
      if (btn) btn.addEventListener('click', () => { window.open('/ide/', '_blank'); });
    } else message.textContent = ({ settings: 'Editor settings are stored in the browser for this prototype.' })[view] || '';
    sideContent.append(message);
  }
}
async function runCommand(command) {
  const output = $('terminal-output'); output.insertAdjacentHTML('beforeend', `<br><span style="color:#72c690">PS workspace &gt; ${escapeText(command)}</span><br>`); output.scrollTop = output.scrollHeight;
  try { const result = await api('/api/run', { method: 'POST', body: JSON.stringify({ command }) }); output.insertAdjacentText('beforeend', result.output || (result.exitCode === 0 ? 'Command completed.' : `Exited with code ${result.exitCode}.`)); if (result.error) output.insertAdjacentText('beforeend', `\n${result.error}`); output.insertAdjacentText('beforeend', '\n'); }
  catch (error) { output.insertAdjacentText('beforeend', `${error.message}\n`); }
  output.scrollTop = output.scrollHeight;
}
async function openQuickOpen() {
  try {
    const files = [];
    async function walk(directory = '') { for (const entry of await listDirectory(directory)) { if (entry.type === 'folder') await walk(entry.path); else files.push(entry); } }
    await walk(); const dialog = $('quick-open-dialog'); const input = $('quick-open-input'); const results = $('quick-open-results'); input.value = '';
    function update() { const query = input.value.toLowerCase(); const filtered = files.filter((file) => file.path.toLowerCase().includes(query)).slice(0, 30); results.innerHTML = filtered.map((file) => `<div class="quick-result" data-path="${escapeText(file.path)}">${escapeText(file.path)}</div>`).join('') || '<div class="empty-tree">No matching files.</div>'; results.querySelectorAll('.quick-result').forEach((row) => row.addEventListener('click', () => { dialog.close(); openFile(row.dataset.path); })); }
    input.oninput = update; update(); dialog.showModal(); input.focus();
  } catch (error) { notify(error.message); }
}
const ANSI_RE = /\x1B\[[0-9;?]*[ -/]*[@-~]/g;
function terminalAppend(text) {
  const output = $('terminal-output');
  output.insertAdjacentText('beforeend', text.replace(ANSI_RE, ''));
  output.scrollTop = output.scrollHeight;
}
function initTerminal() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  try { state.termWs = new WebSocket(`${proto}://${location.host}/api/terminal`); } catch { return; }
  state.termWs.onopen = () => {
    state.termConnected = true;
    const label = document.querySelector('.terminal-label');
    if (label) label.classList.add('connected');
    terminalAppend('\r\n[terminal] connected\r\n');
  };
  state.termWs.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === 'output') terminalAppend(msg.data);
  };
  state.termWs.onclose = () => {
    state.termConnected = false;
    const label = document.querySelector('.terminal-label');
    if (label) label.classList.remove('connected');
  };
  state.termWs.onerror = () => {};
}
async function sendTerminalCommand(command) {
  if (state.termConnected && state.termWs && state.termWs.readyState === 1) {
    terminalAppend(`\r\nPS workspace> ${command}\r\n`);
    state.termWs.send(JSON.stringify({ type: 'input', data: command + '\r\n' }));
    return;
  }
  await runCommand(command);
}
function toggleTerminal(force) { const panel = $('bottom-panel'); const shouldOpen = force ?? panel.classList.contains('hidden'); panel.classList.toggle('hidden', !shouldOpen); if (shouldOpen) $('terminal-command').focus(); }
function showMenu(name, button) {
  const actions = {
    File: [['New File', () => openCreate('file')], ['New Folder', () => openCreate('folder')], ['Quick Open…', openQuickOpen], ['Save', saveActive]],
    Edit: [['Undo', () => state.editor.trigger('menu', 'undo')], ['Redo', () => state.editor.trigger('menu', 'redo')], ['Find', () => state.editor.trigger('menu', 'actions.find')]],
    Selection: [['Select All', () => state.editor.trigger('menu', 'editor.action.selectAll')]],
    View: [['Explorer', () => setView('explorer')], ['Search', () => setView('search')], ['Toggle Terminal', toggleTerminal]],
    Go: [['Quick Open…', openQuickOpen]], Run: [['Run Active JS File', runActiveJsFile], ['Run PowerShell command…', () => { toggleTerminal(true); $('terminal-command').focus(); }]],
    Terminal: [['New Terminal', () => toggleTerminal(true)], ['Run Command…', () => { toggleTerminal(true); $('terminal-command').focus(); }]],
    Help: [['About CodeHarbor', () => notify('CodeHarbor local editor')]],
  };
  const menu = $('menu-popover'); menu.innerHTML = (actions[name] || []).map(([label], index) => `<button data-action="${index}">${escapeText(label)}</button>`).join(''); menu.style.left = `${button.getBoundingClientRect().left}px`; menu.classList.remove('hidden');
  menu.querySelectorAll('button').forEach((item, index) => item.addEventListener('click', () => { menu.classList.add('hidden'); actions[name][index][1](); }));
}
let ctxMenuEl = null;
function closeCtxMenu() {
  if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; }
}
function showCtxMenu(x, y, items) {
  closeCtxMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.setAttribute('role', 'menu');
  for (const item of items) {
    if (item.sep) {
      const s = document.createElement('div');
      s.className = 'ctx-sep';
      menu.append(s);
      continue;
    }
    const b = document.createElement('button');
    b.className = 'ctx-item' + (item.danger ? ' danger' : '');
    b.textContent = item.label;
    b.setAttribute('role', 'menuitem');
    b.addEventListener('click', () => { closeCtxMenu(); item.action(); });
    menu.append(b);
  }
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
  ctxMenuEl = menu;
}
function explorerMenuFor(entry) {
  const items = [];
  if (entry.path === '') {
    items.push({ label: 'New File…', action: () => openCreate('file') });
    items.push({ label: 'New Folder…', action: () => openCreate('folder') });
    items.push({ sep: true });
    items.push({ label: 'Refresh', action: refreshFiles });
    items.push({ label: 'Collapse All', action: () => { state.expanded = new Set(['']); renderTree(); } });
  } else if (entry.type === 'folder') {
    items.push({ label: 'New File…', action: () => { state.selectedPath = entry.path; openCreate('file'); } });
    items.push({ label: 'New Folder…', action: () => { state.selectedPath = entry.path; openCreate('folder'); } });
    items.push({ sep: true });
    items.push({ label: 'Rename…', action: () => startInlineRename(entry) });
    items.push({ label: 'Delete', danger: true, action: () => deleteEntry(entry) });
    items.push({ sep: true });
    items.push({ label: 'Copy Path', action: () => copyPath(entry.path) });
    items.push({ label: 'Refresh', action: refreshFiles });
  } else {
    items.push({ label: 'Open', action: () => openFile(entry.path) });
    items.push({ sep: true });
    items.push({ label: 'Rename…', action: () => startInlineRename(entry) });
    items.push({ label: 'Delete', danger: true, action: () => deleteEntry(entry) });
    items.push({ sep: true });
    items.push({ label: 'Copy Path', action: () => copyPath(entry.path) });
  }
  return items;
}
async function deleteEntry(entry) {
  const label = entry.type === 'folder' ? 'folder' : 'file';
  if (!confirm(`Delete ${label} "${entry.name}"?`)) return;
  try {
    await api(`/api/file?path=${encodeURIComponent(entry.path)}`, { method: 'DELETE' });
    for (const p of [...state.tabs.keys()]) {
      if (p === entry.path || p.startsWith(entry.path + '/')) closeTab(p);
    }
    state.directoryCache.clear();
    state.selectedPath = '';
    await renderTree();
    showStatus(`${label[0].toUpperCase()}${label.slice(1)} deleted`);
  } catch (error) { notify(error.message); }
}
function copyPath(filePath) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(filePath).then(() => showStatus('Path copied'), () => {});
  }
}
function tabMenuFor(filePath) {
  const items = [];
  items.push({ label: 'Save', action: () => { state.activePath = filePath; activateTab(filePath); saveActive(); } });
  items.push({ sep: true });
  items.push({ label: 'Close', action: () => closeTab(filePath) });
  items.push({ label: 'Close Others', action: () => { for (const p of [...state.tabs.keys()]) if (p !== filePath) closeTab(p); } });
  items.push({ label: 'Close All', action: () => { for (const p of [...state.tabs.keys()]) closeTab(p); } });
  items.push({ sep: true });
  items.push({ label: 'Copy Path', action: () => copyPath(filePath) });
  return items;
}
async function startInlineRename(entry) {
  const parent = document.querySelector(`.tree-row[data-path="${CSS.escape(entry.path)}"]`);
  if (!parent) return;
  const nameEl = parent.querySelector('.tree-name');
  if (!nameEl) return;
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = entry.name;
  input.setAttribute('aria-label', 'Rename');
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (commit && value && value !== entry.name) {
      try {
        const result = await api('/api/rename', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: entry.path, newName: value }),
        });
        const newPath = result.path;
        for (const p of [...state.tabs.keys()]) {
          if (p === entry.path) {
            const wasActive = state.activePath === p;
            const model = state.models.get(p);
            const content = model ? model.getValue() : '';
            if (model) { model.dispose(); state.models.delete(p); }
            state.tabs.delete(p);
            const newModel = state.monaco.editor.createModel(content, languageFor(newPath), state.monaco.Uri.parse(`file:///${newPath}`));
            state.models.set(newPath, newModel);
            state.tabs.set(newPath, { dirty: false, model: newModel });
            if (wasActive) activateTab(newPath);
          } else if (p.startsWith(entry.path + '/')) {
            closeTab(p);
          }
        }
        state.directoryCache.clear();
        state.selectedPath = '';
        await renderTree();
        showStatus('Renamed to ' + newPath.split('/').pop());
      } catch (error) {
        notify(error.message);
        await renderTree();
      }
    } else {
      await renderTree();
    }
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}
document.addEventListener('click', (event) => { if (ctxMenuEl && !ctxMenuEl.contains(event.target)) closeCtxMenu(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeCtxMenu(); });
window.addEventListener('blur', closeCtxMenu);
function initMonaco() {
  window.MonacoEnvironment = {
    getWorkerUrl: function (_moduleId, label) {
      if (label === 'json') return '/monaco/vs/language/json/json.worker.js';
      if (label === 'css' || label === 'scss' || label === 'less') return '/monaco/vs/language/css/css.worker.js';
      if (label === 'html' || label === 'handlebars' || label === 'razor') return '/monaco/vs/language/html/html.worker.js';
      if (label === 'typescript' || label === 'javascript') return '/monaco/vs/language/typescript/ts.worker.js';
      return '/monaco/vs/editor/editor.worker.js';
    },
  };
  window.require.config({ paths: { vs: '/monaco/vs' } });
  window.require(['vs/editor/editor.main'], (monaco) => {
    state.monaco = monaco;
    state.editor = monaco.editor.create($('editor'), { value: '', language: 'plaintext', theme: 'vs-dark', automaticLayout: true, minimap: { enabled: true }, fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: 13, lineNumbers: 'on', scrollBeyondLastLine: false, tabSize: 2, wordWrap: 'off' });
    state.editor.onDidChangeCursorPosition(updateCursorStatus);
    state.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveActive);
    state.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, openQuickOpen);
    state.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyJ, () => toggleTerminal());
  }, (error) => notify(`Editor failed to load: ${error.message || error}`));
}

document.querySelectorAll('.activity').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
document.querySelectorAll('.menus button').forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); showMenu(button.dataset.menu, button); }));
document.addEventListener('click', (event) => { if (!event.target.closest('#menu-popover')) $('menu-popover').classList.add('hidden'); });
$('new-file').addEventListener('click', () => openCreate('file'));
$('new-folder').addEventListener('click', () => openCreate('folder'));
$('refresh-files').addEventListener('click', refreshFiles);
$('collapse-all').addEventListener('click', () => { state.expanded = new Set(['']); renderTree(); });
$('welcome-new-file').addEventListener('click', () => openCreate('file'));
$('welcome-open-folder').addEventListener('click', () => setView('explorer'));
$('create-form').addEventListener('submit', createEntry);
$('cancel-create').addEventListener('click', () => createDialog.close());
$('close-panel').addEventListener('click', () => toggleTerminal(false));
$('toggle-terminal').addEventListener('click', () => toggleTerminal());
$('status-terminal').addEventListener('click', () => toggleTerminal());
$('toggle-sidebar').addEventListener('click', () => $('side-panel').classList.toggle('hidden'));
$('terminal-form').addEventListener('submit', async (event) => { event.preventDefault(); const input = $('terminal-command'); const command = input.value.trim(); if (!command) return; input.value = ''; await sendTerminalCommand(command); });
document.querySelectorAll('.panel-tab').forEach((tab) => tab.addEventListener('click', () => { document.querySelectorAll('.panel-tab').forEach((item) => item.classList.toggle('active', item === tab)); state.activePanel = tab.dataset.panel; $('terminal-view').classList.toggle('hidden', state.activePanel !== 'terminal'); $('panel-empty').classList.toggle('hidden', state.activePanel === 'terminal'); if (state.activePanel !== 'terminal') $('panel-empty').textContent = state.activePanel === 'problems' ? 'No problems detected.' : state.activePanel === 'output' ? 'No output yet.' : 'Debug console is idle.'; }));
document.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveActive(); } if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') { event.preventDefault(); openQuickOpen(); } if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'j') { event.preventDefault(); toggleTerminal(); } if (event.key === 'Escape') $('menu-popover').classList.add('hidden'); });
initMonaco();
refreshFiles();
initTerminal();
api('/api/git').then((git) => {
  $('git-status').innerHTML = `⑂ <span>${escapeText(git.repository ? git.branch || 'Detached HEAD' : 'No Git')}</span>`;
  $('git-status').title = git.repository ? `${git.changes} changed files` : 'No Git repository in this workspace';
}).catch(() => {});
$('git-status').addEventListener('click', () => setView('source'));
