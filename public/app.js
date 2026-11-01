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
  try {
    const cachedDirs = [...state.directoryCache.keys()];
    await listDirectory('');
    for (const dir of cachedDirs) {
      if (dir && state.expanded.has(dir)) {
        try { await listDirectory(dir); } catch {}
      }
    }
    await renderTree();
  } catch (error) { notify(error.message); }
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
  const tab = state.tabs.get(state.activePath); if (!tab || tab.readOnly) return;
  try { await api('/api/file', { method: 'PUT', body: JSON.stringify({ path: state.activePath, content: tab.model.getValue() }) }); tab.dirty = false; renderTabs(); showStatus('Saved'); if (state.previewPath === state.activePath) reloadPreview(); }
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
function applyAIContent(path, content) {
  const tab = state.tabs.get(path);
  if (!tab || !tab.model) return;
  tab.model.setValue(content);
  tab.dirty = false;
  if (state.activePath === path) renderTabs();
}
async function chatSend(text) {
  addChatMessage('user', text);
  const active = state.activePath;
  let activeContent = null, selectionText = null, cursorLine = null;
  const tab = active ? state.tabs.get(active) : null;
  if (tab && tab.model) {
    activeContent = tab.model.getValue();
    const sel = state.editor.getSelection();
    if (sel && !sel.isEmpty()) selectionText = tab.model.getValueInRange(sel);
    const pos = state.editor.getPosition();
    if (pos) cursorLine = pos.lineNumber;
  }
  let files = [];
  try { const data = await api('/api/files?path=.'); files = data.entries.map((e) => e.path); } catch {}
  let problems = [];
  try { problems = state.monaco.editor.getModelMarkers({}).map((m) => ({ line: m.startLineNumber, col: m.startColumn, message: m.message })); } catch {}
  const term = $('terminal-output');
  const terminalTail = term ? term.innerText.slice(-2000) : '';
  try {
    const result = await api('/api/ai/agent', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: text, context: { activeFile: active, activeContent, selection: selectionText, cursorLine, files, problems, terminalTail } }),
    });
    const touched = [...new Set([...(result.applied || []), ...(result.created || []), ...(result.deleted || [])])];
    for (const tp of touched) {
      if (tp === active && state.tabs.has(tp)) {
        try { const d = await api('/api/file?path=' + encodeURIComponent(tp)); applyAIContent(tp, d.content); } catch {}
      }
    }
    if (touched.length) await refreshFiles();
    const fresh = result.created || [];
    if (fresh.length && !active) { try { await openFile(fresh[0]); } catch {} }
    addChatMessage('assistant', result.report || 'Done.');
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
  const fixBtn = document.createElement('button'); fixBtn.className = 'run-btn primary'; fixBtn.textContent = 'Fix Active File';
  fixBtn.addEventListener('click', () => { const f = state.activePath; if (!f) { notify('Open a file first.'); return; } chatSend('Fix the active file: ' + f); });
  const explainBtn = document.createElement('button'); explainBtn.className = 'run-btn'; explainBtn.textContent = 'Explain last error';
  const doSend = () => { const v = input.value.trim(); if (!v) return; input.value = ''; chatSend(v); };
  sendBtn.addEventListener('click', doSend);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSend(); });
  explainBtn.addEventListener('click', explainLastError);
  row.append(input, sendBtn);
  wrap.append(status, list, row, fixBtn, explainBtn);
  mountAiPane(wrap);
}
async function showSourcePane() {
  sideContent.replaceChildren();
  let git;
  try { git = await api('/api/git'); } catch (e) { notify(e.message); return; }
  if (!git.repository) {
    const box = document.createElement('div'); box.className = 'empty-tree';
    box.innerHTML = 'No Git repository in this workspace.<br><button class="run-btn primary" id="git-init">Initialize Git Repository</button>';
    box.querySelector('#git-init').addEventListener('click', async () => {
      try { await api('/api/git/init', { method: 'POST' }); await showSourcePane(); } catch (e) { notify(e.message); }
    });
    sideContent.append(box);
    return;
  }
  const wrap = document.createElement('div'); wrap.className = 'source-pane';
  const header = document.createElement('div'); header.className = 'source-header';
  header.innerHTML = `<strong>${escapeText(git.branch)}</strong> <span>${git.changes} changed</span>`;
  const refreshBtn = document.createElement('button'); refreshBtn.textContent = '⟳'; refreshBtn.className = 'run-btn'; refreshBtn.title = 'Refresh';
  refreshBtn.addEventListener('click', () => showSourcePane());
  header.append(refreshBtn);
  const list = document.createElement('div'); list.className = 'source-list';
  for (const entry of git.entries) {
    const row = document.createElement('div'); row.className = 'source-row' + (entry.staged ? ' staged' : '');
    const st = document.createElement('span'); st.className = 'source-status';
    st.textContent = entry.untracked ? 'U' : entry.index + (entry.working.trim() ? entry.working : '');
    const nm = document.createElement('span'); nm.className = 'source-name'; nm.textContent = entry.path; nm.title = entry.path;
    const act = document.createElement('button'); act.className = 'run-btn';
    act.textContent = entry.staged ? 'Unstage' : 'Stage';
    act.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await api(entry.staged ? '/api/git/unstage' : '/api/git/stage', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: entry.path }),
        });
        await showSourcePane();
      } catch (err) { notify(err.message); }
    });
    row.addEventListener('click', () => openDiffTab(entry.path));
    row.append(st, nm, act);
    list.append(row);
  }
  if (!git.entries.length) {
    const empty = document.createElement('div'); empty.className = 'empty-tree';
    empty.textContent = 'No changes yet. Commit your work to snapshot it.';
    list.append(empty);
  }
  const commitBox = document.createElement('div'); commitBox.className = 'source-commit';
  const msgInput = document.createElement('input'); msgInput.placeholder = 'Commit message'; msgInput.id = 'commit-message';
  const allLabel = document.createElement('label'); allLabel.className = 'source-all';
  const allCb = document.createElement('input'); allCb.type = 'checkbox'; allCb.id = 'commit-all';
  allLabel.append(allCb, document.createTextNode(' Commit all changes'));
  const commitBtn = document.createElement('button'); commitBtn.className = 'run-btn primary'; commitBtn.textContent = 'Commit';
  commitBtn.addEventListener('click', async () => {
    const message = msgInput.value.trim();
    if (!message) { notify('Enter a commit message.'); return; }
    try {
      await api('/api/git/commit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, all: allCb.checked }),
      });
      msgInput.value = ''; allCb.checked = false; await showSourcePane(); showStatus('Committed');
    } catch (e) { notify(e.message); }
  });
  commitBox.append(msgInput, allLabel, commitBtn);
  wrap.append(header, list, commitBox);
  sideContent.append(wrap);
}
async function openDiffTab(filePath) {
  try {
    const data = await api(`/api/git/diff?path=${encodeURIComponent(filePath)}`);
    const key = 'diff:' + filePath;
    if (!state.tabs.has(key)) {
      const model = state.monaco.editor.createModel(data.diff, 'diff', state.monaco.Uri.parse(`file:///.diff/${filePath}`));
      state.models.set(key, model);
      state.tabs.set(key, { dirty: false, model, readOnly: true });
    }
    activateTab(key);
  } catch (error) { notify(error.message); }
}

function openPreview(path) {
  state.previewPath = path;
  const panel = $('preview-panel');
  const url = '/preview/' + encodeURIComponent(path).replace(/%2F/g, '/');
  $('preview-url').value = url;
  $('preview-frame').src = url + '?v=' + Date.now();
  $('preview-status').textContent = '● Running';
  panel.classList.remove('hidden');
}
function reloadPreview() {
  if (!state.previewPath) return;
  const url = '/preview/' + encodeURIComponent(state.previewPath).replace(/%2F/g, '/') + '?v=' + Date.now();
  $('preview-frame').src = url;
}
function closePreview() {
  state.previewPath = null;
  $('preview-panel').classList.add('hidden');
  $('preview-frame').src = 'about:blank';
}
async function findHtmlEntry(startPath) {
  const dir = startPath ? startPath.split('/').slice(0, -1).join('/') : '';
  for (const candidate of [dir, '']) {
    try {
      const data = await api('/api/files?path=' + encodeURIComponent(candidate || '.'));
      const html = data.entries.filter(function (e) { return /\.html?$/i.test(e.name); }).sort(function (a, b) {
        if (a.name === 'index.html') return -1;
        if (b.name === 'index.html') return 1;
        return a.name.localeCompare(b.name);
      });
      if (html.length) return html[0].path;
    } catch {}
  }
  return null;
}
async function runProject() {
  const active = state.activePath;
  if (!active) {
    const idx = await findHtmlEntry('');
    if (idx) { await openFile(idx); openPreview(idx); showStatus('Preview started'); return; }
    notify('Open a file first, then press Run.');
    return;
  }
  const ext = extensionOf(active);
  if (ext === 'html' || ext === 'htm') {
    if (state.tabs.get(active) && state.tabs.get(active).dirty) await saveActive();
    openPreview(active);
    showStatus('Preview started');
    return;
  }
  if (ext === 'css' || ext === 'scss') {
    const html = await findHtmlEntry(active);
    if (html) {
      if (state.tabs.get(html) && state.tabs.get(html).dirty) await saveActive();
      openPreview(html);
      showStatus('Previewing with ' + html.split('/').pop());
    } else {
      notify('No HTML file found to preview this CSS. Open the HTML file instead and press Run.');
    }
    return;
  }
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') {
    try {
      const pkg = await api('/api/file?path=package.json');
      const scripts = JSON.parse(pkg.content).scripts || {};
      for (const name of ['dev', 'start', 'serve']) {
        if (scripts[name]) {
          toggleTerminal(true);
          sendTerminalCommand('npm run ' + name);
          showStatus('Started "npm run ' + name + '" in terminal');
          return;
        }
      }
    } catch {}
    toggleTerminal(true);
    sendTerminalCommand('node "' + active + '"');
    showStatus('Running ' + active + ' via node');
    return;
  }
  notify('Run is not supported for .' + ext + ' files yet.');
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
        showSourcePane(); return;
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
function quickOpenScore(query, text) {
  if (!query) return 0;
  let score = 0, qi = 0;
  const q = query.toLowerCase(), t = text.toLowerCase();
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) { score += 10 + qi * 2; qi++; }
  }
  if (qi < q.length) return -1;
  if (t.startsWith(q)) score += 50;
  return score;
}
function renderQuickOpen(files, dialog, input, results) {
  let ranked = [];
  let idx = 0;
  function draw() {
    const query = input.value.trim();
    ranked = files.map(function (f) { return { f: f, s: quickOpenScore(query, f.path) }; })
      .filter(function (x) { return x.s >= 0; }).sort(function (a, b) { return b.s - a.s; }).slice(0, 30).map(function (x) { return x.f; });
    if (!ranked.length) { results.innerHTML = '<div class="empty-tree">No matching files.</div>'; return; }
    results.innerHTML = ranked.map(function (file, i) {
      return '<div class="quick-result' + (i === idx ? ' active' : '') + '" data-path="' + escapeText(file.path) + '"><span class="tree-icon">' + escapeText(iconFor(file)) + '</span><span class="quick-name">' + escapeText(file.path) + '</span></div>';
    }).join('');
    results.querySelectorAll('.quick-result').forEach(function (row, i) {
      row.addEventListener('click', function () { dialog.close(); openFile(ranked[i].path); });
    });
    const active = results.querySelector('.quick-result.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }
  input.onkeydown = function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(idx + 1, ranked.length - 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(idx - 1, 0); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (ranked[idx]) { dialog.close(); openFile(ranked[idx].path); } }
    else if (e.key === 'Escape') { dialog.close(); }
  };
  input.oninput = function () { idx = 0; draw(); };
  draw();
}
async function openQuickOpen() {
  try {
    const files = [];
    async function walk(directory = '') { for (const entry of await listDirectory(directory)) { if (entry.type === 'folder') await walk(entry.path); else files.push(entry); } }
    await walk(); const dialog = $('quick-open-dialog'); const input = $('quick-open-input'); const results = $('quick-open-results'); input.value = '';
    renderQuickOpen(files, dialog, input, results);
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
function mountAiPane(wrap) {
  const dock = $('ai-dock');
  if (state.layout.ai === 'right') {
    $('ai-dock-body').replaceChildren(wrap);
    dock.classList.remove('hidden');
  } else {
    dock.classList.add('hidden');
    sideContent.append(wrap);
  }
}
function persistLayout() {
  try { localStorage.setItem('ch.layout', JSON.stringify(state.layout)); } catch {}
}
function loadLayout() {
  const d = { ai: 'left', dockW: 340, bottomH: 180 };
  try { const saved = JSON.parse(localStorage.getItem('ch.layout')); if (saved && typeof saved === 'object') Object.assign(d, saved); } catch {}
  state.layout = d;
}
function applyLayoutVars() {
  const area = document.querySelector('.editor-area');
  if (!area) return;
  area.style.setProperty('--dock-w', state.layout.dockW + 'px');
  area.style.setProperty('--bottom-h', state.layout.bottomH + 'px');
  const dock = $('ai-dock');
  if (dock) dock.classList.toggle('hidden', state.layout.ai !== 'right');
}
function applyDock(edge) {
  state.layout.ai = edge;
  persistLayout();
  applyLayoutVars();
  const body = $('ai-dock-body');
  if (body.firstElementChild) {
    const wrap = body.firstElementChild;
    body.replaceChildren();
    mountAiPane(wrap);
  }
  if (edge !== 'right') setView('ai');
}
function resetLayout() {
  state.layout = { ai: 'left', dockW: 340, bottomH: 180 };
  persistLayout();
  applyLayoutVars();
  setView('ai');
  notify('Layout reset');
}
function applyZoom(level) {
  const z = Math.min(150, Math.max(75, Math.round(level)));
  state.zoom = z;
  try { localStorage.setItem('ch.zoom', String(z)); } catch {}
  document.body.style.zoom = (z / 100).toString();
  const el = $('zoom-status');
  if (el) el.textContent = z + '%';
}
function initZoom() {
  let z = 100;
  try { const saved = parseInt(localStorage.getItem('ch.zoom'), 10); if (saved >= 75 && saved <= 150) z = saved; } catch {}
  applyZoom(z);
  window.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    applyZoom(state.zoom + (e.deltaY < 0 ? 5 : -5));
  }, { passive: false, capture: true });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === '0') { e.preventDefault(); applyZoom(100); }
  });
}
function initDocking() {
  loadLayout();
  applyLayoutVars();
  let dragging = null;
  const sashR = $('sash-right');
  sashR.addEventListener('mousedown', (e) => { e.preventDefault(); dragging = 'w'; document.body.style.cursor = 'col-resize'; });
  const sashB = $('sash-bottom');
  sashB.addEventListener('mousedown', (e) => { e.preventDefault(); dragging = 'h'; document.body.style.cursor = 'row-resize'; });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const area = document.querySelector('.editor-area');
    const rect = area.getBoundingClientRect();
    if (dragging === 'w') {
      const w = Math.min(Math.max(rect.right - e.clientX, 240), 620);
      state.layout.dockW = Math.round(w);
    } else {
      const h = Math.min(Math.max(rect.bottom - e.clientY, 110), 420);
      state.layout.bottomH = Math.round(h);
    }
    applyLayoutVars();
  });
  document.addEventListener('mouseup', () => {
    if (dragging) { dragging = null; document.body.style.cursor = ''; persistLayout(); }
  });
  const head = $('ai-dock-head');
  if (head) {
    head.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      $('dock-targets').classList.remove('hidden');
      const move = (ev) => {
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const t = el && el.closest ? el.closest('.dock-target') : null;
        document.querySelectorAll('.dock-target').forEach((x) => { x.style.background = ''; });
        if (t) t.style.background = 'rgba(10,120,180,.5)';
      };
      const up = (ev) => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        $('dock-targets').classList.add('hidden');
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const t = el && el.closest ? el.closest('.dock-target') : null;
        if (t) applyDock(t.dataset.dock);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }
  $('ai-dock-hide').addEventListener('click', () => { $('ai-dock').classList.add('hidden'); state.layout.ai = 'hidden'; persistLayout(); });
}
function showMenu(name, button) {
  const actions = {
    File: [['New File', () => openCreate('file')], ['New Folder', () => openCreate('folder')], ['Quick Open…', openQuickOpen], ['Save', saveActive]],
    Edit: [['Undo', () => state.editor.trigger('menu', 'undo')], ['Redo', () => state.editor.trigger('menu', 'redo')], ['Find', () => state.editor.trigger('menu', 'actions.find')]],
    Selection: [['Select All', () => state.editor.trigger('menu', 'editor.action.selectAll')], ['Expand Selection', () => state.editor.trigger('menu', 'editor.action.smartSelect.expand')], ['Shrink Selection', () => state.editor.trigger('menu', 'editor.action.smartSelect.shrink')], ['Add Cursor Above', () => state.editor.trigger('menu', 'editor.action.insertCursorAbove')], ['Add Cursor Below', () => state.editor.trigger('menu', 'editor.action.insertCursorBelow')], ['Select Line', () => state.editor.trigger('menu', 'expandLineSelection')]],
    View: [['Explorer', () => setView('explorer')], ['Search', () => setView('search')], ['Toggle Terminal', toggleTerminal], ['AI Assistant (Left)', () => { state.layout.ai = 'left'; applyDock('left'); }], ['AI Assistant (Right)', () => { state.layout.ai = 'right'; applyDock('right'); }], ['Reset Layout', resetLayout], ['Zoom In', () => applyZoom(state.zoom + 5)], ['Zoom Out', () => applyZoom(state.zoom - 5)], ['Reset Zoom', () => applyZoom(100)]],
    Go: [['Go to File…', openQuickOpen], ['Go to Line…', () => state.editor.trigger('menu', 'editor.action.gotoLine')], ['Go to Symbol…', () => state.editor.trigger('menu', 'editor.action.quickOutline')], ['Go to Definition', () => state.editor.trigger('menu', 'editor.action.revealDefinition')], ['Next Problem', () => state.editor.trigger('menu', 'editor.action.marker.next')], ['Previous Problem', () => state.editor.trigger('menu', 'editor.action.marker.prev')]], Run: [['Run Active JS File', runActiveJsFile], ['Run PowerShell command…', () => { toggleTerminal(true); $('terminal-command').focus(); }]],
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
    state.selectedPath = '';
    await refreshFiles();
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
function registerHtmlSnippets(monaco) {
  const snippets = [
    { label: '!', detail: 'HTML5 boilerplate', insertText: '<!DOCTYPE html>\n<html lang="en">\n<head>\n\t<meta charset="UTF-8">\n\t<meta name="viewport" content="width=device-width, initial-scale=1.0">\n\t<title>Document</title>\n</head>\n<body>\n\t$0\n</body>\n</html>' },
    { label: 'html:5', detail: 'HTML5 boilerplate', insertText: '<!DOCTYPE html>\n<html lang="en">\n<head>\n\t<meta charset="UTF-8">\n\t<meta name="viewport" content="width=device-width, initial-scale=1.0">\n\t<title>Document</title>\n</head>\n<body>\n\t$0\n</body>\n</html>' },
    { label: 'link:css', detail: 'Stylesheet link', insertText: '<link rel="stylesheet" href="$1">' },
    { label: 'script:src', detail: 'External script', insertText: '<script src="$1"></script>' },
    { label: 'img', detail: 'Image element', insertText: '<img src="$1" alt="$2">' },
    { label: 'a', detail: 'Anchor link', insertText: '<a href="$1">$2</a>' },
    { label: 'ul', detail: 'Unordered list', insertText: '<ul>\n\t<li>$1</li>\n</ul>' },
    { label: 'ol', detail: 'Ordered list', insertText: '<ol>\n\t<li>$1</li>\n</ol>' },
    { label: 'div', detail: 'Div container', insertText: '<div>$1</div>' },
    { label: 'section', detail: 'Section', insertText: '<section>$1</section>' },
  ];
  monaco.languages.registerCompletionItemProvider('html', {
    provideCompletionItems: function (model, position) {
      const word = model.getWordUntilPosition(position);
      const prefix = word.word || '';
      const suggestions = [];
      for (const s of snippets) {
        if (!prefix || s.label.indexOf(prefix) === 0) {
          suggestions.push({
            label: s.label,
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: s.insertText,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            detail: s.detail,
            range: { startLineNumber: position.lineNumber, startColumn: word.startColumn, endLineNumber: position.lineNumber, endColumn: position.column },
          });
        }
      }
      return { suggestions: suggestions };
    },
  });
}
function setupHtmlAutoClose(monaco) {
  state.editor.onDidType(function () {
    const model = state.editor.getModel();
    if (!model) return;
    const uri = model.uri && model.uri.path ? model.uri.path : '';
    if (!/\.html?$/i.test(uri)) return;
    const pos = state.editor.getPosition();
    if (!pos) return;
    const line = model.getLineContent(pos.lineNumber);
    if (pos.column < 2) return;
    if (line[pos.column - 2] !== '>') return;
    const before = line.slice(0, pos.column - 1);
    const m = before.match(/<([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^<>]*?)?)>$/);
    if (!m) return;
    const tag = m[1];
    if (/^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(tag)) return;
    if (before.replace(/\s+$/, '').endsWith('/>')) return;
    const after = line.slice(pos.column - 1);
    if (after.trimStart().indexOf('</' + tag + '>') === 0) return;
    state.editor.executeEdits('codeharbor-auto-close', [{
      range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
      text: '</' + tag + '>',
    }]);
    state.editor.setPosition(new monaco.Position(pos.lineNumber, pos.column));
  });
}
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
    state.editor = monaco.editor.create($('editor'), { value: '', language: 'plaintext', theme: 'vs-dark', automaticLayout: true, minimap: { enabled: true }, fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: 13, lineNumbers: 'on', scrollBeyondLastLine: false, tabSize: 2, wordWrap: 'off', tabCompletion: 'on' });
    state.editor.onDidChangeCursorPosition(updateCursorStatus);
    state.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveActive);
    state.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, openQuickOpen);
    state.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyJ, () => toggleTerminal());
    state.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyG, () => state.editor.trigger('menu', 'editor.action.gotoLine'));
    state.editor.addCommand(monaco.KeyCode.F8, () => state.editor.trigger('menu', 'editor.action.marker.next'));
    state.editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F8, () => state.editor.trigger('menu', 'editor.action.marker.prev'));
    state.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, runProject);
    registerHtmlSnippets(monaco);
    setupHtmlAutoClose(monaco);
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
$('run-button').addEventListener('click', runProject);
$('preview-refresh').addEventListener('click', reloadPreview);
$('preview-open').addEventListener('click', () => { if (state.previewPath) window.open('/preview/' + encodeURIComponent(state.previewPath).replace(/%2F/g, '/'), '_blank'); });
$('preview-close').addEventListener('click', closePreview);
$('toggle-sidebar').addEventListener('click', () => $('side-panel').classList.toggle('hidden'));
$('terminal-form').addEventListener('submit', async (event) => { event.preventDefault(); const input = $('terminal-command'); const command = input.value.trim(); if (!command) return; input.value = ''; await sendTerminalCommand(command); });
document.querySelectorAll('.panel-tab').forEach((tab) => tab.addEventListener('click', () => { document.querySelectorAll('.panel-tab').forEach((item) => item.classList.toggle('active', item === tab)); state.activePanel = tab.dataset.panel; $('terminal-view').classList.toggle('hidden', state.activePanel !== 'terminal'); $('panel-empty').classList.toggle('hidden', state.activePanel === 'terminal'); if (state.activePanel !== 'terminal') $('panel-empty').textContent = state.activePanel === 'problems' ? 'No problems detected.' : state.activePanel === 'output' ? 'No output yet.' : 'Debug console is idle.'; }));
document.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveActive(); } if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') { event.preventDefault(); openQuickOpen(); } if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'j') { event.preventDefault(); toggleTerminal(); } if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); runProject(); } if (event.key === 'Escape') $('menu-popover').classList.add('hidden'); });
initMonaco();
refreshFiles();
initDocking();
initZoom();
initTerminal();
api('/api/git').then((git) => {
  $('git-status').innerHTML = `⑂ <span>${escapeText(git.repository ? git.branch || 'Detached HEAD' : 'No Git')}</span>`;
  $('git-status').title = git.repository ? `${git.changes} changed files` : 'No Git repository in this workspace';
}).catch(() => {});
$('git-status').addEventListener('click', () => setView('source'));
