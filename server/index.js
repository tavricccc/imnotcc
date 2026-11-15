import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { WebSocketServer } from 'ws';
import { forkSession, getSessionInfo, getSessionMessages, renameSession } from '@anthropic-ai/claude-agent-sdk';
import { DEV, DIST_DIR, PORT, ROOT } from './config.js';
import * as store from './state.js';
import * as auth from './auth.js';
import * as runners from './runner.js';
import * as wsl from './wsl.js';
import { pluginRoutes } from './plugins.js';
import { claudeSettingsRoutes } from './claudeSettings.js';
import { fileRoutes } from './files.js';
import { browseRoutes } from './browse.js';
import { pushRoutes } from './push.js';
import { claudeLoginRoutes } from './claudeLogin.js';

store.load();
auth.ensureAuth();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '2mb' }));

const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk'];
const httpsRequest = (req) => req.headers['x-forwarded-proto'] === 'https';
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.post('/api/login', (req, res) => {
  if (!auth.sameOrigin(req)) return res.status(403).json({ error: 'origin' });
  if (!auth.loginAllowed()) return res.status(429).json({ error: '嘗試太多次，請一分鐘後再試。' });
  if (!auth.checkPassword(req.body?.password)) { auth.noteFailure(); return res.status(401).json({ error: '密碼不對。' }); }
  auth.issueCookie(res, httpsRequest(req));
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => res.json({ authed: auth.isAuthed(req) }));

// Everything below needs a login, and anything that changes state must come from this site.
app.use('/api', (req, res, next) => {
  if (!auth.isAuthed(req)) return res.status(401).json({ error: 'login' });
  if (req.method !== 'GET' && !auth.sameOrigin(req)) return res.status(403).json({ error: 'origin' });
  next();
});

app.post('/api/logout', (_req, res) => { auth.clearCookie(res); res.json({ ok: true }); });

app.post('/api/password', (req, res) => {
  const { current, next } = req.body ?? {};
  if (!auth.checkPassword(current)) return res.status(401).json({ error: '目前的密碼不對。' });
  if (typeof next !== 'string' || next.length < 8) return res.status(400).json({ error: '新密碼至少 8 個字元。' });
  auth.setPassword(next, { changed: true });
  auth.removePasswordFile();
  auth.issueCookie(res, httpsRequest(req));
  res.json({ ok: true });
});

// ---- Sessions ----
const sessionMeta = (id) => store.get().sessions[id];
const requireSession = (req, res) => {
  const meta = sessionMeta(req.params.id);
  if (!meta) res.status(404).json({ error: '找不到這個對話。' });
  return meta;
};

app.get('/api/sessions', wrap(async (_req, res) => {
  const s = store.get();
  const items = await Promise.all(Object.entries(s.sessions).map(async ([id, meta]) => {
    const info = await wsl.readFor(meta.cwd, () => getSessionInfo(id, { dir: meta.cwd })).catch(() => null);
    return {
      id, cwd: meta.cwd, title: info?.customTitle || info?.summary || '',
      lastModified: info?.lastModified ?? meta.createdAt, createdAt: meta.createdAt,
      started: !!info, running: runners.isRunning(id), temporary: !!meta.temporary,
    };
  }));
  const groups = new Map();
  const recent = [];
  for (const item of items) {
    if (item.temporary) {
      recent.push(item);
      continue;
    }
    if (!groups.has(item.cwd)) groups.set(item.cwd, []);
    groups.get(item.cwd).push(item);
  }
  const out = [...groups].map(([cwd, list]) => ({ cwd, sessions: list.sort((a, b) => b.lastModified - a.lastModified) }))
    .sort((a, b) => b.sessions[0].lastModified - a.sessions[0].lastModified);
  res.json({ groups: out, recent: recent.sort((a, b) => b.lastModified - a.lastModified) });
}));

function createSession(id, b) {
  const temporary = b.temporary === true;
  const st = store.get();
  let cwd;
  if (temporary) {
    if (b.environment !== 'win' && b.environment !== 'wsl') {
      throw Object.assign(new Error('請選擇執行環境。'), { status: 400 });
    }
    const documents = documentsDir(b.environment);
    if (!documents) throw Object.assign(new Error('找不到 WSL。'), { status: 400 });
    const paths = pathOf(documents);
    const root = paths.join(documents, 'cc-temp');
    const date = new Date().toISOString().slice(0, 10);
    fs.mkdirSync(onHost(root), { recursive: true });
    const created = fs.mkdtempSync(onHost(paths.join(root, `${date}-`)));
    cwd = paths.join(root, path.basename(created));
  } else {
    cwd = checkFolder(b.cwd);
    if (!cwd) throw Object.assign(new Error('資料夾不存在。'), { status: 400 });
  }
  const meta = { cwd, createdAt: Date.now() };
  if (temporary) meta.temporary = true;
  if (PERMISSION_MODES.includes(b.permissionMode)) meta.permissionMode = b.permissionMode;
  if (typeof b.model === 'string') meta.model = b.model;
  if (typeof b.effort === 'string') meta.effort = b.effort;
  st.sessions[id] = meta;
  // A folder picked from the browser joins the list, so it is one tap away next time.
  const addFolder = !temporary && !st.folders.includes(cwd);
  if (addFolder) st.folders.push(cwd);
  function undo() {
    delete st.sessions[id];
    if (addFolder && !Object.values(st.sessions).some((session) => session.cwd === cwd)) {
      st.folders = st.folders.filter((folder) => folder !== cwd);
    }
    if (temporary) {
      try { fs.rmdirSync(onHost(cwd)); } catch {}
    }
  }
  try { store.save(); }
  catch (e) { undo(); throw e; }
  return undo;
}

app.post('/api/sessions', (req, res) => {
  const id = crypto.randomUUID();
  try { createSession(id, req.body ?? {}); }
  catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    throw e;
  }
  res.json({ id });
});

app.get('/api/sessions/:id', wrap(async (req, res) => {
  const meta = requireSession(req, res);
  if (!meta) return;
  const info = await wsl.readFor(meta.cwd, () => getSessionInfo(req.params.id, { dir: meta.cwd })).catch(() => null);
  res.json({ id: req.params.id, cwd: meta.cwd, title: info?.customTitle || info?.summary || '', started: !!info, temporary: !!meta.temporary });
}));

// The last `limit` messages before index `before` (the end, when not given).
app.get('/api/sessions/:id/messages', wrap(async (req, res) => {
  const meta = requireSession(req, res);
  if (!meta) return;
  const all = await wsl.readFor(meta.cwd, () => getSessionMessages(req.params.id, { dir: meta.cwd })).catch(() => []);
  const limit = Math.min(Number(req.query.limit) || 100, 5000);
  const end = req.query.before !== undefined ? Math.max(0, Math.min(Number(req.query.before), all.length)) : all.length;
  const start = Math.max(0, end - limit);
  res.json({ messages: all.slice(start, end), start, total: all.length });
}));

// What each turn changed, by the prompt that started it, for folders in a git repository.
app.get('/api/sessions/:id/changes', (req, res) => {
  const meta = requireSession(req, res);
  if (!meta) return;
  res.json(meta.changes ?? {});
});

fileRoutes(app, { requireSession, wrap });
browseRoutes(app, { requireSession, wrap });

app.post('/api/sessions/:id/fork',wrap(async (req, res) => {
  const meta = requireSession(req, res);
  if (!meta) return;
  const { sessionId } = await wsl.readFor(meta.cwd, () => forkSession(req.params.id, { dir: meta.cwd }));
  store.get().sessions[sessionId] = { ...meta, createdAt: Date.now() };
  store.save();
  res.json({ id: sessionId });
}));

app.post('/api/sessions/:id/rename', wrap(async (req, res) => {
  const meta = requireSession(req, res);
  if (!meta) return;
  const title = String(req.body?.title ?? '').trim();
  if (!title) return res.status(400).json({ error: '名稱不能是空的。' });
  await wsl.readFor(meta.cwd, () => renameSession(req.params.id, title, { dir: meta.cwd }));
  res.json({ ok: true });
}));

// Takes the session off the list. Its transcript stays where Claude Code keeps it.
app.delete('/api/sessions/:id', (req, res) => {
  if (!requireSession(req, res)) return;
  runners.runnerFor(req.params.id).close();
  delete store.get().sessions[req.params.id];
  store.save();
  res.json({ ok: true });
});

// ---- Folders and settings ----
function checkFolder(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const dir = wsl.isWsl(raw.trim()) ? path.posix.resolve(raw.trim()) : path.resolve(raw.trim());
  try { return fs.statSync(onHost(dir)).isDirectory() ? dir : null; } catch { return null; }
}
// Where this server opens a folder: WSL paths go through //wsl.localhost.
const onHost = (dir) => (wsl.isWsl(dir) ? wsl.hostPath(dir) : dir);
const pathOf = (dir) => (wsl.isWsl(dir) ? path.posix : path);

function documentsDir(environment) {
  if (process.platform !== 'win32') return path.join(os.homedir(), 'Documents');
  if (environment === 'wsl') {
    const home = wsl.homeDir();
    return home ? path.posix.join(home, 'Documents') : null;
  }
  // Windows can redirect Documents outside the user's home folder.
  return execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Environment]::GetFolderPath('MyDocuments', 'DoNotVerify')",
  ], { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim() || path.join(os.homedir(), 'Documents');
}

// ---- Folder browser: the directories on this computer, for picking a session's folder ----
// On Windows, "/" stands for WSL's root when WSL is installed.
function driveRoots() {
  if (process.platform !== 'win32') return ['/'];
  const drives = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\`).filter((d) => { try { fs.accessSync(d); return true; } catch { return false; } });
  return wsl.available() ? [...drives, '/'] : drives;
}

app.get('/api/fs', (req, res) => {
  const raw = typeof req.query.path === 'string' && req.query.path ? req.query.path : null;
  const asked = raw ? pathOf(raw).resolve(raw) : null;
  if (!asked) return res.json({ path: null, parent: null, dirs: driveRoots(), home: process.env.USERPROFILE || process.env.HOME, wslHome: wsl.homeDir() });
  let entries;
  try { entries = fs.readdirSync(onHost(asked), { withFileTypes: true }); } catch (e) { return res.status(400).json({ error: `打不開這個資料夾：${e.code ?? e.message}` }); }
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !/^(\$|System Volume Information$|node_modules$)/.test(e.name))
    .map((e) => e.name).sort((a, b) => a.localeCompare(b, 'zh-Hant', { sensitivity: 'base' }));
  const parent = pathOf(asked).dirname(asked);
  res.json({ path: asked, parent: parent === asked ? null : parent, dirs });
});

app.post('/api/fs/mkdir', (req, res) => {
  const base = checkFolder(req.body?.path);
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!base) return res.status(400).json({ error: '資料夾不存在。' });
  if (!name || /[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') return res.status(400).json({ error: '名稱不能有 \\ / :* ? " < > |。' });
  const dir = pathOf(base).join(base, name);
  try { fs.mkdirSync(onHost(dir)); } catch (e) { return res.status(400).json({ error: e.code === 'EEXIST' ? '已經有這個資料夾了。' : String(e.message) }); }
  res.json({ path: dir });
});

app.get('/api/folders', (_req, res) => res.json({ folders: store.get().folders }));
app.post('/api/folders', (req, res) => {
  const dir = checkFolder(req.body?.path);
  if (!dir) return res.status(400).json({ error: '資料夾不存在。' });
  const s = store.get();
  if (!s.folders.includes(dir)) s.folders.push(dir);
  store.save();
  res.json({ folders: s.folders });
});
app.delete('/api/folders', (req, res) => {
  const s = store.get();
  s.folders = s.folders.filter((f) => f !== req.body?.path);
  if (s.settings.folder === req.body?.path) s.settings.folder = null;
  store.save();
  res.json({ folders: s.folders });
});

app.get('/api/settings', (_req, res) => res.json({ settings: store.get().settings }));
app.put('/api/settings', (req, res) => {
  const s = store.get().settings;
  const b = req.body ?? {};
  if (b.permissionMode !== undefined) {
    if (!PERMISSION_MODES.includes(b.permissionMode)) return res.status(400).json({ error: 'mode' });
    s.permissionMode = b.permissionMode;
  }
  if (b.model !== undefined) s.model = b.model || null;
  if (b.effort !== undefined) s.effort = b.effort || null;
  if (b.folder !== undefined) s.folder = b.folder || null;
  if (b.idleMinutes !== undefined) {
    const n = Number(b.idleMinutes);
    if (!Number.isInteger(n) || n < 0 || n > 24 * 60) return res.status(400).json({ error: 'idle' });
    s.idleMinutes = n;
  }
  store.save();
  res.json({ settings: s });
});

app.get('/api/usage', async (req, res) => res.json({ plan: req.query.refresh ? await runners.refreshPlan() : runners.getPlanUsage() }));
app.get('/api/controls', async (_req, res) => {
  try { res.json({ controls: await runners.probeControls(os.homedir()) }); }
  catch (e) { res.json({ controls: null, error: String(e?.message ?? e) }); }
});

const SDK_PKG = '@anthropic-ai/claude-agent-sdk';
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
function isNewerVersion(latest, current) {
  if (!latest || !current || latest === current) return false;
  const parse = (v) => {
    const [core, pre = ''] = String(v).trim().replace(/^v/, '').split('-', 2);
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.nums.length, b.nums.length); i++) {
    const diff = (a.nums[i] ?? 0) - (b.nums[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  if (!a.pre && b.pre) return true;
  if (a.pre && !b.pre) return false;
  return a.pre > b.pre;
}

app.get('/api/sdk', wrap(async (req, res) => {
  const installed = readJson(path.join(ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'));
  const rootPkg = readJson(path.join(ROOT, 'package.json'));
  const current = installed?.version ?? null;
  const declared = rootPkg?.dependencies?.[SDK_PKG] ?? null;
  if (req.query.check !== '1') {
    return res.json({ current, declared, latest: null, updateAvailable: false });
  }
  try {
    const r = await fetch(`https://registry.npmjs.org/${encodeURIComponent(SDK_PKG)}/latest`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`npm registry HTTP ${r.status}`);
    const meta = await r.json();
    const latest = typeof meta?.version === 'string' ? meta.version : null;
    res.json({ current, declared, latest, updateAvailable: !!(latest && current && isNewerVersion(latest, current)) });
  } catch (e) {
    res.json({ current, declared, latest: null, updateAvailable: false, checkError: String(e?.message ?? e) });
  }
}));

pluginRoutes(app, wrap);
pushRoutes(app);
claudeSettingsRoutes(app, wrap);
claudeLoginRoutes(app, wrap);

app.use('/api', (err, _req, res, _next) => {
  console.error('[imnotcc]', err);
  res.status(500).json({ error: String(err?.message ?? err) });
});

if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR, { index: false }));
  app.get(/^\/(?!api\/|ws$).*/, (_req, res) => res.sendFile(path.join(DIST_DIR, 'index.html')));
}

// ---- Sockets: one per open page; it follows the sessions it subscribes to ----
const server = http.createServer(app);
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const wss = new WebSocketServer({ noServer: true, maxPayload: 24 * 1024 * 1024 });
const startingSessions = new Map();

function readPrompt(m) {
  const text = typeof m.text === 'string' ? m.text.trim() : '';
  const images = Array.isArray(m.images) ? m.images.slice(0, 8).filter((x) =>
    IMAGE_TYPES.has(x?.mediaType) && typeof x.data === 'string' && /^[A-Za-z0-9+/=]+$/.test(x.data)) : [];
  return { text, images };
}

async function startSession(id, m) {
  if (startingSessions.has(id)) return startingSessions.get(id);
  // The draft keeps its ID across reconnects, including when the reply was lost.
  if (sessionMeta(id)) return;
  const { text, images } = readPrompt(m);
  if (!text && !images.length) throw new Error('請輸入訊息或加入圖片。');
  const undo = createSession(id, m);
  const request = runners.runnerFor(id).send(text, images, id).catch((error) => {
    runners.forget(id);
    undo();
    store.save();
    throw error;
  }).finally(() => startingSessions.delete(id));
  startingSessions.set(id, request);
  return request;
}

server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws' || !auth.isAuthed(req) || !auth.sameOrigin({ headers: req.headers, method: 'WS' })) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

wss.on('connection', (ws) => {
  const subs = new Set();
  const socketId = crypto.randomUUID();
  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
  const off = runners.onEvent((id, event) => {
    if (id !== null && !subs.has(id)) return;
    if (event.kind === 'prompt') {
      const { from, ...rest } = event;
      return send({ session: id, ...rest, ...(from === socketId ? { images: [] } : {}) });
    }
    send({ session: id, ...event });
  });
  ws.on('close', off);
  ws.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const id = m?.session;
    if (m?.t === 'start') {
      if (typeof id !== 'string' || !UUID.test(id)) return;
      try {
        await startSession(id, m);
        send({ session: id, kind: 'started' });
      } catch (e) {
        send({ session: id, kind: 'start-error', message: String(e?.message ?? e) });
      }
      return;
    }
    if (!id || !sessionMeta(id)) return send({ session: id ?? null, kind: 'error', message: '找不到這個對話。' });
    const r = runners.runnerFor(id);
    try {
      switch (m.t) {
        case 'sub': subs.add(id); send({ session: id, ...r.snapshot() }); break;
        case 'unsub': subs.delete(id); break;
        case 'send': {
          const { text, images } = readPrompt(m);
          const uuid = typeof m.uuid === 'string' && UUID.test(m.uuid) ? m.uuid : undefined;
          if (text || images.length) await r.send(text, images, uuid, { queue: m.queue === true, from: socketId });
          break;
        }
        case 'unqueue': if (typeof m.uuid === 'string') r.unqueue(m.uuid); break;
        case 'interrupt': await r.interrupt(); break;
        case 'usage': await r.refreshUsage(); break;
        case 'mode':
          if (!PERMISSION_MODES.includes(m.mode)) throw new Error('unknown mode');
          await r.setMode(m.mode);
          break;
        case 'model': await r.setModel(m.model); break;
        case 'effort': await r.setEffort(m.effort); break;
        case 'restart': r.close(); break;
        case 'task-output':
          if (typeof m.task !== 'string') break;
          send({ session: id, kind: 'task-output', task: m.task, ...(await r.taskOutput(m.task) ?? { output: '', truncated: false, bytes: 0, gone: true }) });
          break;
        case 'task-stop': if (typeof m.task === 'string') await r.stopTask(m.task); break;
        case 'answer': r.answer(m.id, m); break;
        default: break;
      }
    } catch (e) {
      send({ session: id, kind: 'error', message: String(e?.message ?? e) });
    }
  });
});

const stop = () => { runners.closeAll(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

// Loopback only: the public address reaches this machine through the Cloudflare tunnel.
server.listen(PORT, '127.0.0.1', () => console.log(`[imnotcc] listening on http://127.0.0.1:${PORT}${DEV ? ' (dev)' : ''}`));
