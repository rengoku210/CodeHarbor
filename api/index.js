const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const app = express();
app.use(express.json({ limit: '10mb' }));

// Workspace for serverless environment (uses /tmp on Vercel)
const WORKSPACE = process.env.VERCEL
  ? path.join('/tmp', 'workspace')
  : path.join(__dirname, '..', 'workspace');

function initWorkspace() {
  try {
    fs.mkdirSync(WORKSPACE, { recursive: true });
    const indexPath = path.join(WORKSPACE, 'index.html');
    if (!fs.existsSync(indexPath)) {
      fs.writeFileSync(indexPath, '<!DOCTYPE html>\n<html>\n<head>\n  <meta charset="utf-8">\n  <title>Hello CodeHarbor</title>\n  <link rel="stylesheet" href="styles.css">\n</head>\n<body>\n  <h1>Welcome to CodeHarbor</h1>\n  <p>Start editing this file or use the AI assistant to help you write code!</p>\n</body>\n</html>\n', 'utf8');
      fs.writeFileSync(path.join(WORKSPACE, 'styles.css'), 'body {\n  font-family: sans-serif;\n  background: #111;\n  color: #eee;\n  padding: 2rem;\n}\n', 'utf8');
    }
  } catch {}
}
initWorkspace();

// AI configuration from environment
const AI_KEY = process.env.INCEPTION_API_KEY || '';
const AI_BASE = (process.env.INCEPTION_BASE_URL || 'https://api.inceptionlabs.ai/v1').replace(/\/+$/, '');
const AI_MODEL = process.env.INCEPTION_MODEL || 'mercury-3';

function toWorkspaceRelative(filePath) {
  const rel = path.relative(WORKSPACE, filePath).split(path.sep).join('/');
  return rel === '' ? '.' : rel;
}

function resolveWorkspacePath(rawPath) {
  const safe = typeof rawPath === 'string' ? rawPath.trim() : '';
  const target = safe === '' || safe === '.' ? WORKSPACE : path.resolve(WORKSPACE, safe.replace(/\\/g, '/'));
  const rel = path.relative(WORKSPACE, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Invalid workspace path');
  }
  return target;
}

function readDirectoryEntries(targetPath) {
  const entries = fs.readdirSync(targetPath, { withFileTypes: true });
  return entries
    .map((e) => ({
      name: e.name,
      path: toWorkspaceRelative(path.join(targetPath, e.name)),
      type: e.isDirectory() ? 'folder' : 'file',
    }))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1));
}

// AI endpoints
app.get('/api/ai/status', (req, res) => {
  res.json({ configured: Boolean(AI_KEY), model: AI_MODEL });
});

async function askAI(messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
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
    return { content: data.choices?.[0]?.message?.content ?? '' };
  } catch (err) {
    return { error: `AI request error: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

app.post('/api/ai/chat', async (req, res) => {
  if (!AI_KEY) return res.status(500).json({ error: 'AI is not configured (missing INCEPTION_API_KEY in Vercel environment).' });
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages must be an array.' });
  }
  const result = await askAI(messages);
  if (result.error) return res.status(502).json({ error: result.error });
  return res.json({ content: result.content });
});

app.post('/api/ai/explain-error', async (req, res) => {
  if (!AI_KEY) return res.status(500).json({ error: 'AI is not configured (missing INCEPTION_API_KEY in Vercel environment).' });
  const { error } = req.body || {};
  if (!error) return res.status(400).json({ error: 'error text is required.' });
  const result = await askAI([
    { role: 'system', content: 'You are a debugging assistant. Explain the error concisely and suggest fixes. Use plain text.' },
    { role: 'user', content: `Error:\n${error.slice(0, 4000)}` },
  ]);
  if (result.error) return res.status(502).json({ error: result.error });
  return res.json({ content: result.content });
});

app.post('/api/ai/agent', async (req, res) => {
  if (!AI_KEY) return res.status(500).json({ error: 'AI is not configured (missing INCEPTION_API_KEY in Vercel environment).' });
  const { goal, context } = req.body || {};
  if (!goal) return res.status(400).json({ error: 'goal is required.' });
  const cx = context || {};
  const prompt = [
    cx.activeFile ? `Active file: ${cx.activeFile}` : '',
    cx.activeContent ? `Active content:\n${cx.activeContent.slice(0, 8000)}` : '',
    `User request: ${goal}`,
  ].filter(Boolean).join('\n\n');

  const result = await askAI([
    { role: 'system', content: 'You are CodeHarbor AI assistant. Provide concise help or code changes.' },
    { role: 'user', content: prompt },
  ]);
  if (result.error) return res.status(502).json({ error: result.error });
  return res.json({ report: result.content, applied: [], created: [], deleted: [] });
});

// File endpoints
app.get('/api/files', (req, res) => {
  try {
    initWorkspace();
    const folder = resolveWorkspacePath(req.query.path || '.');
    return res.json({ entries: readDirectoryEntries(folder) });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get('/api/file', (req, res) => {
  try {
    const fp = resolveWorkspacePath(req.query.path || '');
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
    return res.json({ path: toWorkspaceRelative(fp), content: fs.readFileSync(fp, 'utf8') });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.put('/api/file', (req, res) => {
  try {
    const fp = resolveWorkspacePath(req.body?.path || '');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, String(req.body?.content ?? ''), 'utf8');
    return res.json({ ok: true, path: toWorkspaceRelative(fp) });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.post('/api/create', (req, res) => {
  try {
    const { path: rel, kind } = req.body || {};
    const target = resolveWorkspacePath(rel || '');
    if (kind === 'folder') {
      fs.mkdirSync(target, { recursive: true });
      return res.json({ ok: true, path: toWorkspaceRelative(target), kind: 'folder' });
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '', 'utf8');
    return res.json({ ok: true, path: toWorkspaceRelative(target), kind: 'file' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.delete('/api/file', (req, res) => {
  try {
    const target = resolveWorkspacePath(req.query.path || '');
    if (target === WORKSPACE) return res.status(400).json({ error: 'Cannot delete root' });
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: false });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get('/api/git', (req, res) => {
  res.json({ repository: true, branch: 'main', changes: 0, entries: [] });
});

// Preview route
app.use('/preview', (req, res) => {
  try {
    const rel = decodeURIComponent(req.path || '/').replace(/^\//, '');
    const fp = resolveWorkspacePath(rel);
    if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      return res.sendFile(fp);
    }
    return res.status(404).send('Preview file not found');
  } catch (err) {
    return res.status(400).send(err.message);
  }
});

module.exports = app;
