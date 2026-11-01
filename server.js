const express = require('express');
const { WebSocketServer } = require('ws');
const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const RUNTIME = path.join(ROOT, '.runtime');
const CS_DIR = path.join(RUNTIME, 'code-server-4.143.1-windows-amd64');
const CS_BIN = path.join(CS_DIR, 'lib', 'node.exe');
const CS_ENTRY = CS_DIR; // code-server uses its own root as entry
const WORKSPACE = path.join(ROOT, 'workspace');
const STATE_DIR = path.join(RUNTIME, 'state');
const USER_DATA = path.join(RUNTIME, 'user-data');
const EXT_DIR = path.join(RUNTIME, 'extensions');
const CONFIG = path.join(RUNTIME, 'config.yaml');

// load optional .env for AI config (never committed; read from disk at startup)
function loadEnv() {
  const out = {};
  try {
    const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch {}
  return out;
}
const ENV = loadEnv();
const AI_KEY = ENV.INCEPTION_API_KEY || '';
const AI_BASE = (ENV.INCEPTION_BASE_URL || 'https://api.inceptionlabs.ai/v1').replace(/\/+$/, '');
const AI_MODEL = ENV.INCEPTION_MODEL || 'mercury-3';

const PROXY_PORT = 4170;   // what CodeHarbor exposes
const CS_PORT = 4171;      // internal code-server port

fs.mkdirSync(WORKSPACE, { recursive: true });
fs.mkdirSync(STATE_DIR, { recursive: true });

// write code-server config
const configContent = [
  `bind-addr: 127.0.0.1:${CS_PORT}`,
  'auth: none',
  'cert: false',
  'disable-telemetry: true',
  'disable-update-check: true',
  'app-name: CodeHarbor',
  `user-data-dir: '${USER_DATA.replace(/\\/g, '/')}'`,
  `extensions-dir: '${EXT_DIR.replace(/\\/g, '/')}'`,
].join('\n');
fs.writeFileSync(CONFIG, configContent);

let csProcess = null;

function startCodeServer() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(CS_BIN)) {
      console.warn(`code-server binary not found at ${CS_BIN}. Skipping code-server.`);
      return resolve();
    }
    const args = [
      CS_ENTRY,
      '--config', CONFIG,
      WORKSPACE,
    ];

    csProcess = spawn(CS_BIN, args, {
      cwd: WORKSPACE,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        // don't let code-server open a browser
        BROWSER: 'none',
      },
    });

    const stderrLog = fs.createWriteStream(path.join(STATE_DIR, 'code-server.stderr.log'));
    const stdoutLog = fs.createWriteStream(path.join(STATE_DIR, 'code-server.stdout.log'));
    csProcess.stderr.pipe(stderrLog);
    csProcess.stdout.pipe(stdoutLog);

    fs.writeFileSync(path.join(STATE_DIR, 'code-server.pid'), String(csProcess.pid));

    csProcess.on('error', (err) => {
      console.error('code-server failed to start:', err.message);
      reject(err);
    });

    csProcess.on('exit', (code, signal) => {
      console.log(`code-server exited (code=${code}, signal=${signal})`);
      csProcess = null;
    });

    // wait for code-server to be ready
    let attempts = 0;
    const maxAttempts = 60;
    const check = () => {
      attempts++;
      const req = http.get(`http://127.0.0.1:${CS_PORT}/healthz`, (res) => {
        if (res.statusCode === 200) {
          console.log(`code-server ready on port ${CS_PORT} after ${attempts} checks`);
          resolve();
        } else if (attempts < maxAttempts) {
          setTimeout(check, 500);
        } else {
          reject(new Error('code-server did not become healthy'));
        }
      });
      req.on('error', () => {
        if (attempts < maxAttempts) setTimeout(check, 500);
        else reject(new Error('code-server did not start'));
      });
      req.end();
    };
    setTimeout(check, 1000);
  });
}

// inject custom CSS branding into code-server
function injectBranding() {
  const customCssDir = path.join(USER_DATA, 'User');
  fs.mkdirSync(customCssDir, { recursive: true });

  // settings to set window title and misc
  const settingsPath = path.join(customCssDir, 'settings.json');
  let existingSettings = {};
  try { existingSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}

  const settings = {
    ...existingSettings,
    'window.title': 'CodeHarbor — ${activeEditorShort}${separator}${rootName}',
    'window.menuBarVisibility': 'classic',
    'workbench.colorTheme': existingSettings['workbench.colorTheme'] || 'Default Dark Modern',
    'workbench.startupEditor': existingSettings['workbench.startupEditor'] || 'welcomePageInEmptyWorkbench',
    'terminal.integrated.defaultProfile.windows': 'PowerShell',
    'editor.fontFamily': existingSettings['editor.fontFamily'] || 'Consolas, "Cascadia Code", monospace',
    'editor.fontSize': existingSettings['editor.fontSize'] || 13,
    'editor.minimap.enabled': existingSettings['editor.minimap.enabled'] !== undefined ? existingSettings['editor.minimap.enabled'] : true,
    'editor.tabSize': existingSettings['editor.tabSize'] || 2,
  };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

// product.json overrides for branding and marketplace
function patchProduct() {
  const productPath = path.join(CS_DIR, 'lib', 'vscode', 'product.json');
  if (!fs.existsSync(productPath)) return;
  let product = {};
  try { product = JSON.parse(fs.readFileSync(productPath, 'utf8')); } catch {}

  // point extensions to Open VSX
  product.extensionsGallery = {
    serviceUrl: 'https://open-vsx.org/vscode/gallery',
    itemUrl: 'https://open-vsx.org/vscode/item',
    resourceUrlTemplate: 'https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}',
    controlUrl: '',
    nlsBaseUrl: '',
    publisherUrl: '',
  };

  product.nameShort = 'CodeHarbor';
  product.nameLong = 'CodeHarbor';
  // keep applicationName as-is for compatibility

  fs.writeFileSync(productPath, JSON.stringify(product, null, 2));
}

function toWorkspaceRelative(filePath) {
  const relative = path.relative(WORKSPACE, filePath).split(path.sep).join('/');
  return relative === '' ? '.' : relative;
}

function resolveWorkspacePath(rawPath) {
  const safeInput = typeof rawPath === 'string' ? rawPath.trim() : '';
  const target = safeInput === '' || safeInput === '.' ? WORKSPACE : path.resolve(WORKSPACE, safeInput.replace(/\\/g, '/'));
  const relative = path.relative(WORKSPACE, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Invalid workspace path');
  }
  return target;
}

function readDirectoryEntries(targetPath) {
  const entries = fs.readdirSync(targetPath, { withFileTypes: true });
  return entries
    .map((entry) => {
      const fullPath = path.join(targetPath, entry.name);
      const relativePath = toWorkspaceRelative(fullPath);
      return {
        name: entry.name,
        path: relativePath,
        type: entry.isDirectory() ? 'folder' : 'file',
      };
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1));
}

function searchFiles(root, query) {
  const results = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === '.runtime' || entry.name === 'node_modules') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const text = fs.readFileSync(fullPath, 'utf8');
      if (!text.toLowerCase().includes(query.toLowerCase())) continue;
      const line = text.split(/\r?\n/).find((candidate) => candidate.toLowerCase().includes(query.toLowerCase())) || '';
      results.push({
        path: toWorkspaceRelative(fullPath),
        line: text.split(/\r?\n/).indexOf(line) + 1 || 1,
        preview: line.trim() || text.slice(0, 80),
      });
    }
  };
  walk(root);
  return results;
}

async function main() {
  console.log('CodeHarbor starting...');
  console.log(`Workspace: ${WORKSPACE}`);

  injectBranding();
  patchProduct();

  await startCodeServer();

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(express.static(PUBLIC_DIR));
  // Serve the Monaco editor (minified AMD build) that the frontend loads from /monaco/vs/loader.js
  app.use('/monaco', express.static(path.join(ROOT, 'node_modules', 'monaco-editor', 'min')));

  // landing page at root that redirects to the IDE
  app.get('/codeharbor-landing', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>CodeHarbor</title>
<style>
body{margin:0;background:#1e1e1e;color:#ccc;font-family:"Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center;height:100vh}
.card{text-align:center}
.logo{width:80px;height:80px;border:2px solid #4aa3df;border-radius:18px;display:grid;place-items:center;color:#62b7ef;font-size:28px;font-weight:700;margin:0 auto 20px}
h1{font-weight:400;color:#e0e0e0;margin:0 0 8px}
p{color:#888;margin:0 0 24px}
a{display:inline-block;padding:10px 24px;background:#0e639c;color:#fff;text-decoration:none;border-radius:4px}
a:hover{background:#1177bb}
</style></head><body>
<div class="card"><div class="logo">CH</div><h1>CodeHarbor</h1>
<p>Your development environment is ready.</p>
<a href="/ide">Open IDE</a></div></body></html>`);
  });

  app.get('/', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  app.get('/ide', (req, res) => {
    res.redirect('/ide/');
  });

  app.use('/ide', (req, res) => {
    const proxyPath = (req.originalUrl || req.url || '/').replace(/^\/ide/, '') || '/';
    const proxyReq = http.request({
      hostname: '127.0.0.1',
      port: CS_PORT,
      path: proxyPath,
      method: req.method,
      headers: {
        ...req.headers,
        host: `127.0.0.1:${CS_PORT}`,
      },
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error('IDE proxy error:', err.message);
      if (!res.headersSent) {
        res.writeHead(502);
        res.end('code-server unavailable');
      }
    });

    req.pipe(proxyReq);
  });

  app.get('/api/files', (req, res) => {
    try {
      const folder = resolveWorkspacePath(req.query.path || '.');
      if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
        return res.status(404).json({ error: 'Folder not found' });
      }
      return res.json({ entries: readDirectoryEntries(folder) });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/file', (req, res) => {
    try {
      const filePath = resolveWorkspacePath(req.query.path || '');
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return res.status(404).json({ error: 'File not found' });
      }
      return res.json({ path: toWorkspaceRelative(filePath), content: fs.readFileSync(filePath, 'utf8') });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  app.put('/api/file', (req, res) => {
    try {
      const targetPath = resolveWorkspacePath(req.body?.path || '');
      const parentDir = path.dirname(targetPath);
      fs.mkdirSync(parentDir, { recursive: true });
      fs.writeFileSync(targetPath, String(req.body?.content ?? ''), 'utf8');
      return res.json({ ok: true, path: toWorkspaceRelative(targetPath) });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/create', (req, res) => {
    try {
      const { path: relativePath, kind } = req.body || {};
      const targetPath = resolveWorkspacePath(relativePath || '');
      if (kind === 'folder') {
        fs.mkdirSync(targetPath, { recursive: true });
        return res.json({ ok: true, path: toWorkspaceRelative(targetPath), kind: 'folder' });
      }
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      if (fs.existsSync(targetPath)) {
        return res.status(400).json({ error: 'A file with that name already exists' });
      }
      fs.writeFileSync(targetPath, '', 'utf8');
      return res.json({ ok: true, path: toWorkspaceRelative(targetPath), kind: 'file' });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  // rename a file or folder (name only, within its current parent)
  app.post('/api/rename', (req, res) => {
    try {
      const { path: oldPath, newName } = req.body || {};
      if (!oldPath || !newName || typeof newName !== 'string') {
        return res.status(400).json({ error: 'Path and new name are required.' });
      }
      const safeNew = newName.trim();
      if (!safeNew || safeNew === '.' || safeNew === '..' || /[<>:"|?*]/.test(safeNew) || safeNew.includes('/') || safeNew.includes('\\')) {
        return res.status(400).json({ error: 'Invalid name.' });
      }
      const src = resolveWorkspacePath(oldPath);
      if (src === WORKSPACE) return res.status(400).json({ error: 'Cannot rename the workspace root.' });
      if (!fs.existsSync(src)) return res.status(404).json({ error: 'Not found.' });
      const dest = path.join(path.dirname(src), safeNew);
      if (dest === src) return res.json({ ok: true, path: toWorkspaceRelative(src) });
      if (fs.existsSync(dest)) return res.status(400).json({ error: 'A file or folder with that name already exists.' });
      fs.renameSync(src, dest);
      return res.json({ ok: true, path: toWorkspaceRelative(dest) });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  // move a file or folder to another location inside the workspace
  app.post('/api/move', (req, res) => {
    try {
      const { from, to } = req.body || {};
      if (!from || !to) return res.status(400).json({ error: 'from and to are required.' });
      const src = resolveWorkspacePath(from);
      const dest = resolveWorkspacePath(to);
      if (src === WORKSPACE) return res.status(400).json({ error: 'Cannot move the workspace root.' });
      if (!fs.existsSync(src)) return res.status(404).json({ error: 'Source not found.' });
      if (dest === src) return res.json({ ok: true, path: toWorkspaceRelative(src) });
      if (fs.existsSync(dest)) return res.status(400).json({ error: 'Destination already exists.' });
      if (dest.startsWith(src + path.sep)) return res.status(400).json({ error: 'Cannot move a folder into itself.' });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(src, dest);
      return res.json({ ok: true, path: toWorkspaceRelative(dest) });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  // delete a file or folder (recursive for folders)
  app.delete('/api/file', (req, res) => {
    try {
      const target = resolveWorkspacePath(req.query.path || '');
      if (target === WORKSPACE) return res.status(400).json({ error: 'Cannot delete the workspace root.' });
      if (!fs.existsSync(target)) return res.status(404).json({ error: 'Not found.' });
      fs.rmSync(target, { recursive: true, force: false });
      return res.json({ ok: true });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/search', (req, res) => {
    try {
      const query = String(req.query.q || '').trim();
      if (!query) {
        return res.json({ results: [] });
      }
      return res.json({ results: searchFiles(WORKSPACE, query) });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  // --- Git helpers and routes ---
  function runGit(args, opts = {}) {
    return require('node:child_process').execFileSync('git', ['-C', WORKSPACE, ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...opts,
    });
  }
  function parsePorcelain(out) {
    const entries = [];
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const x = line[0];
      const y = line[1];
      let path = line.slice(3);
      if (path.startsWith('"')) {
        try { path = JSON.parse(path); } catch {}
      }
      let oldPath = null;
      const arrow = path.indexOf(' -> ');
      if (arrow !== -1 && (x === 'R' || x === 'C')) {
        oldPath = path.slice(0, arrow);
        path = path.slice(arrow + 4);
      }
      entries.push({ path, oldPath, index: x, working: y, staged: x !== ' ' && x !== '?' && x !== '!', untracked: x === '?' });
    }
    return entries;
  }

  app.get('/api/git', (req, res) => {
    try {
      const gitDir = path.join(WORKSPACE, '.git');
      if (!fs.existsSync(gitDir)) {
        return res.json({ repository: false, branch: null, changes: 0, entries: [] });
      }
      const branchOut = runGit(['branch', '--show-current']).trim();
      let aheadBehind = '';
      try { aheadBehind = runGit(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']).trim() || ''; } catch {}
      const statusOut = runGit(['status', '--porcelain=v1']);
      const entries = parsePorcelain(statusOut);
      return res.json({ repository: true, branch: branchOut || 'Detached HEAD', changes: entries.length, entries, aheadBehind });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/git/init', (req, res) => {
    try {
      runGit(['init']);
      return res.json({ ok: true });
    } catch (error) { return res.status(400).json({ error: error.message }); }
  });

  app.post('/api/git/stage', (req, res) => {
    try {
      const p = resolveWorkspacePath(req.body?.path || '');
      const rel = toWorkspaceRelative(p);
      runGit(['add', '-A', '--', rel]);
      return res.json({ ok: true });
    } catch (error) { return res.status(400).json({ error: error.message }); }
  });

  app.post('/api/git/unstage', (req, res) => {
    try {
      const p = resolveWorkspacePath(req.body?.path || '');
      const rel = toWorkspaceRelative(p);
      runGit(['restore', '--staged', '--', rel]);
      return res.json({ ok: true });
    } catch (error) { return res.status(400).json({ error: error.message }); }
  });

  app.get('/api/git/diff', (req, res) => {
    try {
      const p = resolveWorkspacePath(String(req.query.path || ''));
      const rel = toWorkspaceRelative(p);
      const gitDir = path.join(WORKSPACE, '.git');
      if (!fs.existsSync(gitDir)) return res.status(400).json({ error: 'Not a git repository.' });
      let diff = '';
      try { diff = runGit(['diff', '--', rel]); } catch {}
      if (!diff) { try { diff = runGit(['diff', '--cached', '--', rel]); } catch {} }
      if (!diff) {
        const content = fs.readFileSync(p, 'utf8');
        diff = content.split(/\r?\n/).map((l) => '+' + l).join('\n');
        diff = `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n${diff}\n`;
      }
      return res.json({ path: rel, diff });
    } catch (error) { return res.status(400).json({ error: error.message }); }
  });

  app.post('/api/git/commit', (req, res) => {
    try {
      const message = String(req.body?.message || '').trim();
      const all = Boolean(req.body?.all);
      if (!message) return res.status(400).json({ error: 'A commit message is required.' });
      if (all) {
        runGit(['add', '-A']);
      } else {
        const statusOut = runGit(['status', '--porcelain=v1']);
        const entries = parsePorcelain(statusOut);
        if (!entries.some((e) => e.staged)) {
          return res.status(400).json({ error: 'There are no staged changes to commit.' });
        }
      }
      runGit(['commit', '-m', message]);
      return res.json({ ok: true });
    } catch (error) { return res.status(400).json({ error: error.message }); }
  });

  app.post('/api/run', (req, res) => {
    const { command } = req.body || {};
    if (!command || typeof command !== 'string') {
      return res.status(400).json({ error: 'A command is required.' });
    }
    const { exec } = require('node:child_process');
    exec(command, { cwd: WORKSPACE, shell: 'powershell.exe' }, (error, stdout, stderr) => {
      const output = [stdout, stderr].filter(Boolean).join('');
      res.json({
        output,
        exitCode: error ? error.code ?? 1 : 0,
        error: stderr || (error ? error.message : ''),
      });
    });
  });

  // ---- AI Agent: workspace file editing (restricted to WORKSPACE) ----
  function aiResolve(rawPath) {
    if (typeof rawPath !== 'string' || !rawPath.trim()) throw new Error('Path is required.');
    const target = resolveWorkspacePath(rawPath.trim());
    if (target === WORKSPACE) throw new Error('Cannot target the workspace root.');
    return target;
  }
  function aiListFiles(folderPath) {
    const dir = folderPath ? aiResolve(folderPath) : WORKSPACE;
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('Folder not found: ' + folderPath);
    const entries = fs.readdirSync(dir, { withFileTypes: true }).map((d) => ({
      name: d.name,
      type: d.isDirectory() ? 'folder' : 'file',
      path: toWorkspaceRelative(path.join(dir, d.name)),
    }));
    return { entries };
  }
  function aiReadFile(filePath) {
    const target = aiResolve(filePath);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error('File not found: ' + filePath);
    const stat = fs.statSync(target);
    if (stat.size > 262144) throw new Error('File too large to read via AI (' + stat.size + ' bytes).');
    return { content: fs.readFileSync(target, 'utf8') };
  }
  function aiWriteFile(filePath, content) {
    const target = aiResolve(filePath);
    if (typeof content !== 'string') throw new Error('content must be a string.');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    return { ok: true, path: toWorkspaceRelative(target), bytes: Buffer.byteLength(content, 'utf8') };
  }
  function aiPatchFile(filePath, edits) {
    const target = aiResolve(filePath);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error('File not found: ' + filePath);
    if (!Array.isArray(edits) || edits.length === 0) throw new Error('edits must be a non-empty array.');
    const lines = fs.readFileSync(target, 'utf8').split('\n');
    const normal = edits.map((e) => ({
      action: e.action,
      startLine: Number(e.startLine) || 1,
      endLine: Number(e.endLine) || (Number(e.startLine) || 1),
      text: typeof e.text === 'string' ? e.text : '',
    })).sort((a, b) => b.startLine - a.startLine);
    for (const e of normal) {
      const s = Math.max(1, e.startLine);
      const en = Math.max(s, e.endLine);
      if (s > lines.length + 1) throw new Error('Edit startLine out of range: ' + s);
      if (e.action === 'replace') {
        lines.splice(s - 1, en - s + 1, ...e.text.split('\n'));
      } else if (e.action === 'insert') {
        lines.splice(s - 1, 0, ...e.text.split('\n'));
      } else if (e.action === 'delete') {
        lines.splice(s - 1, en - s + 1);
      } else {
        throw new Error('Unknown edit action: ' + e.action);
      }
    }
    fs.writeFileSync(target, lines.join('\n'), 'utf8');
    return { ok: true, path: toWorkspaceRelative(target) };
  }
  function aiDeleteFile(filePath) {
    const target = aiResolve(filePath);
    if (!fs.existsSync(target)) throw new Error('Not found: ' + filePath);
    fs.rmSync(target, { recursive: true, force: false });
    return { ok: true, path: toWorkspaceRelative(target) };
  }
  function aiRenameFile(from, to) {
    const src = aiResolve(from);
    const dest = aiResolve(to);
    if (!fs.existsSync(src)) throw new Error('Not found: ' + from);
    if (fs.existsSync(dest)) throw new Error('Destination already exists: ' + to);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    return { ok: true, path: toWorkspaceRelative(dest) };
  }
  function executeAiTool(action) {
    switch (action.tool) {
      case 'list_files': return aiListFiles(action.path);
      case 'read_file': return aiReadFile(action.path);
      case 'write_file': return aiWriteFile(action.path, action.content);
      case 'patch_file': return aiPatchFile(action.path, action.edits);
      case 'delete_file': return aiDeleteFile(action.path);
      case 'rename_file': return aiRenameFile(action.from, action.to);
      default: throw new Error('Unknown tool: ' + action.tool);
    }
  }

  // Serve workspace files for the Preview panel (path-safe, proper MIME types).
  // Must be mounted before the catch-all proxy to code-server.
  app.use('/preview', express.static(WORKSPACE, { index: false }));

  const AI_TOOL_SYSTEM =
    'You are the CodeHarbor AI coding agent. You can inspect and modify files inside the workspace.\n' +
    'When asked to create, fix, modify, or improve code, USE A TOOL instead of dumping code into the chat.\n' +
    'Available tools. Always answer with ONLY a JSON object (no prose, no markdown fences) of one of these forms:\n' +
    '{"tool":"list_files","path":"<dir or empty>"}\n' +
    '{"tool":"read_file","path":"<file>"}\n' +
    '{"tool":"write_file","path":"<file>","content":"<full new content>"}\n' +
    '{"tool":"patch_file","path":"<file>","edits":[{"action":"replace|insert|delete","startLine":N,"endLine":N,"text":"<text>"}]}\n' +
    '{"tool":"delete_file","path":"<file>"}\n' +
    '{"tool":"rename_file","from":"<file>","to":"<file>"}\n' +
    'Edits: replace swaps lines startLine..endLine with text; insert puts text before startLine; delete removes lines startLine..endLine.\n' +
    'Paths are workspace-relative (e.g. "src/app.js"). After finishing all tool calls, respond with a final summary (plain text): ' +
    'what you changed and why, in 2-4 short sentences. If the user asked for an explanation or question, just answer directly without tools.';

  app.post('/api/ai/agent', async (req, res) => {
    if (!AI_KEY) return res.status(500).json({ error: 'AI is not configured (missing INCEPTION_API_KEY in .env).' });
    const { goal, context } = req.body || {};
    if (!goal || typeof goal !== 'string') return res.status(400).json({ error: 'goal is required.' });
    const cx = (typeof context === 'object' && context) || {};
    const applied = [], created = [], deleted = [];
    const messages = [{ role: 'system', content: AI_TOOL_SYSTEM }];
    const contextParts = [];
    if (cx.activeFile) contextParts.push('Active file: ' + cx.activeFile);
    if (typeof cx.activeContent === 'string') contextParts.push('Active file contents (current editor buffer):\n' + cx.activeContent.slice(0, 12000));
    if (cx.selection) contextParts.push('Selection in active file:\n' + String(cx.selection).slice(0, 4000));
    if (cx.cursorLine) contextParts.push('Cursor line: ' + cx.cursorLine);
    if (Array.isArray(cx.files) && cx.files.length) contextParts.push('Workspace top-level entries: ' + cx.files.join(', '));
    if (Array.isArray(cx.problems) && cx.problems.length) {
      contextParts.push('Current problems/diagnostics:\n' + cx.problems.slice(0, 30).map((p) => `[${p.line}:${p.col}] ${p.message}`).join('\n'));
    }
    if (cx.terminalTail) contextParts.push('Recent terminal output:\n' + String(cx.terminalTail).slice(-2000));
    messages.push({ role: 'user', content: contextParts.join('\n\n') + '\n\nUser request: ' + goal });

    let report = '', finalText = '';
    for (let round = 0; round < 6; round++) {
      const result = await askAI(messages);
      if (result.error) {
        if (!report) return res.status(502).json({ error: result.error });
        break;
      }
      const text = result.content.trim();
      finalText = text;
      let action = null;
      const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      const candidate = fence ? fence[1] : text;
      try { action = JSON.parse(candidate); } catch {}
      if (!action || typeof action.tool !== 'string') { report = text; break; }
      try {
        const toolResult = executeAiTool(action);
        if (action.tool === 'write_file') created.push(action.path);
        else if (action.tool === 'delete_file') deleted.push(action.path);
        else if (action.tool === 'patch_file' || action.tool === 'rename_file') applied.push(action.path || toolResult.path);
        messages.push({ role: 'assistant', content: candidate });
        messages.push({ role: 'user', content: 'TOOL RESULT (JSON):\n' + JSON.stringify(toolResult) });
      } catch (err) {
        messages.push({ role: 'assistant', content: candidate });
        messages.push({ role: 'user', content: 'TOOL ERROR: ' + err.message + ' Please correct the request and try again, or respond with a final summary.' });
      }
    }
    return res.json({ report: report || finalText, applied, created, deleted });
  });

  // health endpoint
  app.get('/codeharbor/health', (req, res) => {
    res.json({ status: 'ok', codeServer: csProcess ? 'running' : 'stopped', workspace: WORKSPACE });
  });

  // ---- AI endpoints (OpenAI-compatible, key from .env only) ----
  async function askAI(messages) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    try {
      const response = await fetch(`${AI_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_KEY}` },
        body: JSON.stringify({ model: AI_MODEL, messages, temperature: 0.2, max_tokens: 1500 }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return { error: `AI request failed (${response.status}): ${text.slice(0, 300)}` };
      }
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content ?? '';
      return { content };
    } catch (err) {
      return { error: `AI request error: ${err.message}` };
    } finally {
      clearTimeout(timer);
    }
  }

  app.get('/api/ai/status', (req, res) => {
    res.json({ configured: Boolean(AI_KEY), model: AI_MODEL });
  });

  app.post('/api/ai/chat', async (req, res) => {
    if (!AI_KEY) return res.status(500).json({ error: 'AI is not configured (missing INCEPTION_API_KEY in .env).' });
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0 || !messages.every((m) => m && typeof m.content === 'string')) {
      return res.status(400).json({ error: 'messages must be an array of {role, content}.' });
    }
    const result = await askAI(messages);
    if (result.error) return res.status(502).json({ error: result.error });
    return res.json({ content: result.content });
  });

  app.post('/api/ai/explain-error', async (req, res) => {
    if (!AI_KEY) return res.status(500).json({ error: 'AI is not configured (missing INCEPTION_API_KEY in .env).' });
    const { error } = req.body || {};
    if (!error || typeof error !== 'string') return res.status(400).json({ error: 'error text is required.' });
    const result = await askAI([
      { role: 'system', content: 'You are a concise debugging assistant for a browser IDE. Explain the error below in 3-6 sentences and suggest concrete fixes. Use plain text, no markdown.' },
      { role: 'user', content: `Error output:\n${error.slice(0, 4000)}` },
    ]);
    if (result.error) return res.status(502).json({ error: result.error });
    return res.json({ content: result.content });
  });

  // proxy everything else to code-server
  const server = http.createServer((req, res) => {
    // handle express routes first
    app(req, res, () => {
      // not an express route — proxy to code-server
      const proxyReq = http.request({
        hostname: '127.0.0.1',
        port: CS_PORT,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          host: `127.0.0.1:${CS_PORT}`,
        },
      }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });

      proxyReq.on('error', (err) => {
        console.error('Proxy error:', err.message);
        if (!res.headersSent) {
          res.writeHead(502);
          res.end('code-server unavailable');
        }
      });

      req.pipe(proxyReq);
    });
  });

  // local terminal WebSocket — persistent PowerShell session in the workspace
  const terminalWss = new WebSocketServer({ noServer: true });
  terminalWss.on('connection', (ws) => {
    let proc = null;
    const startShell = () => {
      try {
        proc = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass'], {
          cwd: WORKSPACE,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        proc.stdout.on('data', (d) => ws.send(JSON.stringify({ type: 'output', data: d.toString() })));
        proc.stderr.on('data', (d) => ws.send(JSON.stringify({ type: 'output', data: d.toString() })));
        proc.on('error', (err) => ws.send(JSON.stringify({ type: 'output', data: `\r\n[terminal] ${err.message}\r\n` })));
        proc.on('close', (code) => ws.send(JSON.stringify({ type: 'exit', code })));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'output', data: `\r\n[terminal] failed to start: ${err.message}\r\n` }));
      }
    };
    startShell();
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'input' && typeof msg.data === 'string') {
        if (proc) proc.stdin.write(msg.data);
      } else if (msg.type === 'kill') {
        try { if (proc) proc.kill(); } catch {}
      }
    });
    ws.on('close', () => { try { if (proc) proc.kill(); } catch {} });
  });

  // WebSocket upgrade — terminal first, otherwise proxy to code-server
  server.on('upgrade', (req, socket, head) => {
    if (req.url && req.url.startsWith('/api/terminal')) {
      terminalWss.handleUpgrade(req, socket, head, (ws) => terminalWss.emit('connection', ws, req));
      return;
    }
    const proxySocket = net.connect(CS_PORT, '127.0.0.1', () => {
      const reqLine = `${req.method} ${req.url} HTTP/1.1\r\n`;
      const headers = Object.entries(req.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n');
      proxySocket.write(reqLine + headers + '\r\n\r\n');
      if (head.length) proxySocket.write(head);
      socket.pipe(proxySocket).pipe(socket);
    });

    proxySocket.on('error', (err) => {
      console.error('WebSocket proxy error:', err.message);
      socket.destroy();
    });
    socket.on('error', () => proxySocket.destroy());
  });

  server.listen(PROXY_PORT, '127.0.0.1', () => {
    console.log(`CodeHarbor listening on http://127.0.0.1:${PROXY_PORT}/`);
    fs.writeFileSync(path.join(STATE_DIR, 'codeharbor.pid'), String(process.pid));
  });

  // cleanup
  const shutdown = () => {
    console.log('Shutting down...');
    if (csProcess) {
      try { process.kill(csProcess.pid); } catch {}
    }
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', () => {
    if (csProcess) try { process.kill(csProcess.pid); } catch {}
  });
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
