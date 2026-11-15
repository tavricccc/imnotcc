// Files Claude mentions, opened from the chat: which of the paths in a reply exist, a file's
// text for the preview panel, its bytes for images and PDFs, and what a turn changed in one file.
//
// A path is read the way the session reads it: relative ones from the session's folder, "~/"
// from that environment's home, Linux paths in a WSL session through //wsl.localhost. Any file
// on this computer can be opened except keys and credentials (sensitive.js); the login in front
// of the app is the boundary, the same as for running Claude itself.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as wsl from './wsl.js';
import * as changes from './changes.js';
import { isSensitive } from './sensitive.js';

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_RAW_BYTES = 50 * 1024 * 1024;
const MAX_RESOLVE = 100;

const IMAGE = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
// Shown in the browser as they are. Anything else is only ever sent as a download, so a page
// written by Claude never runs on this site's origin.
const INLINE = { ...IMAGE, '.pdf': 'application/pdf' };
const MARKDOWN = new Set(['.md', '.markdown', '.mdx']);
const HTML = new Set(['.html', '.htm']);

const sessionPath = (cwd) => (wsl.isWsl(cwd) ? path.posix : path.win32);

/**
 * Where a path written in a session points: `shown` in the session's own notation (a Linux path
 * in WSL), `host` as this server opens it. Null for an empty or malformed path.
 */
export function locate(cwd, raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s || s.includes('\0')) return null;
  const p = sessionPath(cwd);
  const home = wsl.isWsl(cwd) ? wsl.homeDir() : os.homedir();
  const named = /^~[\\/]/.test(s) && home ? p.join(home, s.slice(2)) : s;
  // A Windows path named from a WSL session is opened as it is.
  if (process.platform === 'win32' && /^[A-Za-z]:[\\/]/.test(named)) {
    const shown = path.win32.resolve(named);
    return { shown, host: shown };
  }
  const shown = p.isAbsolute(named) ? p.resolve(named) : p.resolve(cwd, named);
  return { shown, host: wsl.isWsl(cwd) ? wsl.hostPath(shown) : shown };
}

// A file's first bytes say whether it is text: a NUL byte means it is not.
function looksBinary(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } finally { fs.closeSync(fd); }
}

/** What kind of preview a file gets. */
function kindOf(file, stat) {
  if (stat.isDirectory()) return 'dir';
  const ext = path.extname(file).toLowerCase();
  if (IMAGE[ext]) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (MARKDOWN.has(ext)) return 'markdown';
  if (HTML.has(ext)) return 'html';
  try { return looksBinary(file) ? 'binary' : 'text'; } catch { return 'binary'; }
}

/** The file a path points at, or null when it is not there. */
function inspect(cwd, raw) {
  const where = locate(cwd, raw);
  if (!where) return null;
  try {
    const real = fs.realpathSync(where.host);
    // Keys and credentials are never opened, whatever path leads to them.
    if (isSensitive(where.host) || isSensitive(real)) return { ...where, real, blocked: true };
    const stat = fs.statSync(real);
    return { ...where, real, stat, kind: kindOf(real, stat) };
  } catch { return null; }
}

// Preview links: token -> the folder it opens, until it has gone unused for a while.
const GRANT_MS = 60 * 60 * 1000;
const MAX_GRANTS = 200;
const grants = new Map();
// The page runs scripts but in an origin of its own, so it cannot reach this app or its login.
const PREVIEW_HEADERS = {
  'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  // A sandboxed page's own origin is opaque: module scripts and fetches back to its folder need this.
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
};

function previewLink(file) {
  const now = Date.now();
  for (const [k, g] of grants) if (g.expires < now) grants.delete(k);
  while (grants.size >= MAX_GRANTS) grants.delete(grants.keys().next().value);
  const token = crypto.randomBytes(24).toString('base64url');
  grants.set(token, { dir: path.dirname(file), expires: now + GRANT_MS });
  return `/preview/${token}/${encodeURIComponent(path.basename(file))}`;
}

const BLOCKED = '這個檔案可能含有金鑰或密碼，不能從這裡開啟。';
/** The file a request names, or null after answering 404/403 for it. */
function opened(meta, raw, res, missing = '找不到這個檔案。') {
  const f = inspect(meta.cwd, raw);
  if (!f) { res.status(404).json({ error: missing }); return null; }
  if (f.blocked) { res.status(403).json({ error: BLOCKED }); return null; }
  return f;
}

const describe = (f) => ({ path: f.shown, hostPath: f.real, name: path.basename(f.real), kind: f.kind, size: f.stat.size, mtime: f.stat.mtimeMs });

export function fileRoutes(app, { requireSession, wrap }) {
  // Which of the paths a reply names exist. Those that do not come back as null, so the chat
  // leaves them as plain text.
  app.post('/api/sessions/:id/resolve', (req, res) => {
    const meta = requireSession(req, res);
    if (!meta) return;
    const paths = Array.isArray(req.body?.paths) ? req.body.paths.slice(0, MAX_RESOLVE) : [];
    res.json({ files: paths.map((p) => { const f = inspect(meta.cwd, p); return f && !f.blocked ? describe(f) : null; }) });
  });

  // A file's text for the preview panel; files that are not text, or too large, come back with
  // their details only.
  app.get('/api/sessions/:id/file', (req, res) => {
    const meta = requireSession(req, res);
    if (!meta) return;
    const f = opened(meta, req.query.path, res);
    if (!f) return;
    if (f.kind === 'dir') return res.status(404).json({ error: '找不到這個檔案。' });
    const info = describe(f);
    if (!['text', 'markdown', 'html'].includes(f.kind)) return res.json(info);
    if (f.stat.size > MAX_TEXT_BYTES) return res.json({ ...info, tooLarge: true });
    res.set('Cache-Control', 'private, no-cache').json({ ...info, text: fs.readFileSync(f.real, 'utf8') });
  });

  // A file's bytes: images and PDFs to show, anything else as a download.
  const raw = (req, res) => {
    const meta = requireSession(req, res);
    if (!meta) return;
    const f = opened(meta, req.query.path, res);
    if (!f) return;
    if (!f.stat.isFile()) return res.status(404).json({ error: '找不到這個檔案。' });
    if (f.stat.size > MAX_RAW_BYTES) return res.status(413).json({ error: '檔案太大。' });
    const type = INLINE[path.extname(f.real).toLowerCase()];
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-cache' };
    if (type) return res.sendFile(f.real, { dotfiles: 'allow', headers: { ...headers, 'Content-Type': type } });
    res.attachment(path.basename(f.real)).sendFile(f.real, { dotfiles: 'allow', headers: { ...headers, 'Content-Type': 'application/octet-stream' } });
  };
  app.get('/api/sessions/:id/raw', raw);

  // The image route the chat has always used: only images, or 403.
  app.get('/api/sessions/:id/image', (req, res) => {
    const meta = requireSession(req, res);
    if (!meta) return;
    const f = opened(meta, req.query.path, res, '找不到這張圖片。');
    if (!f) return;
    if (f.kind !== 'image') return res.status(403).json({ error: '不能開這個檔案。' });
    raw(req, res);
  });

  // A local HTML page, opened in a new tab. The link carries a token that lets that tab read the
  // page's folder for a while; it needs no login, because a sandboxed page sends no cookies.
  app.post('/api/sessions/:id/preview-link', (req, res) => {
    const meta = requireSession(req, res);
    if (!meta) return;
    const f = inspect(meta.cwd, req.body?.path);
    if (!f || f.blocked || f.kind !== 'html') return res.status(400).json({ error: '只能這樣開 HTML 檔。' });
    res.json({ url: previewLink(f.real) });
  });

  app.get('/preview/:token/*rest', (req, res) => {
    const grant = grants.get(req.params.token);
    if (!grant || grant.expires < Date.now()) return res.status(404).type('text/plain').send('這個預覽連結已經過期，回到 imnotcc 再開一次。');
    grant.expires = Date.now() + GRANT_MS;
    const rel = [].concat(req.params.rest ?? []).join('/');
    let real;
    try { real = fs.realpathSync(path.resolve(grant.dir, rel)); } catch { return res.status(404).type('text/plain').send('找不到這個檔案。'); }
    // Only inside the page's folder, symlinks included.
    if (real !== grant.dir && !real.startsWith(grant.dir + path.sep)) return res.status(403).type('text/plain').send('不能開這個資料夾以外的檔案。');
    if (isSensitive(real)) return res.status(403).type('text/plain').send(BLOCKED);
    if (!fs.statSync(real).isFile()) return res.status(404).type('text/plain').send('找不到這個檔案。');
    res.sendFile(real, { dotfiles: 'allow', headers: PREVIEW_HEADERS });
  });

  // One file's change in one turn, as a unified diff between the turn's two snapshots.
  app.get('/api/sessions/:id/diff', wrap(async (req, res) => {
    const meta = requireSession(req, res);
    if (!meta) return;
    const trees = meta.trees?.[String(req.query.turn ?? '')];
    const file = String(req.query.path ?? '');
    if (!trees) return res.status(404).json({ error: '這個回合沒有保留變更內容。' });
    if (!(meta.changes?.[req.query.turn] ?? []).some((c) => c.path === file)) return res.status(404).json({ error: '這個回合沒有改到這個檔案。' });
    const patch = await changes.patch(trees, file).catch(() => null);
    if (patch === null) return res.status(410).json({ error: '這個回合的變更內容已經被 git 清掉了。' });
    res.json({ path: file, patch });
  }));
}
