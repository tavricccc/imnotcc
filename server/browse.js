// The file browser: a folder's entries and a search over a folder, file names or contents.
// Paths are read the way files.js reads them (relative to the session's folder, Linux paths in a
// WSL session); keys and credentials (sensitive.js) are left out of both.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import * as wsl from './wsl.js';
import { locate } from './files.js';
import { isSensitive, RG_EXCLUDES } from './sensitive.js';

const MAX_ENTRIES = 5000;
const MAX_RESULTS = 200;
const SEARCH_MS = 15_000;
const SKIP_DIRS = new Set(['.git', 'node_modules']);

const sessionPath = (cwd) => (wsl.isWsl(cwd) ? path.posix : path.win32);

/** A folder a request names (the session's own when none), or null after answering for it. */
function folder(meta, raw, res) {
  const where = locate(meta.cwd, typeof raw === 'string' && raw ? raw : meta.cwd);
  let stat;
  try { stat = where && fs.statSync(where.host); } catch {}
  if (!stat?.isDirectory()) { res.status(404).json({ error: '找不到這個資料夾。' }); return null; }
  let real = where.host;
  try { real = fs.realpathSync(where.host); } catch {}
  if (isSensitive(where.host) || isSensitive(real)) { res.status(403).json({ error: '這個資料夾可能含有金鑰或密碼，不能從這裡開啟。' }); return null; }
  return where;
}

/** A folder's entries, folders first; also used for zipping. */
export function listDir(where, p) {
  const dirents = fs.readdirSync(where.host, { withFileTypes: true });
  const entries = [];
  for (const d of dirents) {
    if (entries.length >= MAX_ENTRIES) break;
    const host = path.join(where.host, d.name);
    if (isSensitive(host)) continue;
    if (d.isSymbolicLink()) {
      try { if (isSensitive(fs.realpathSync(host))) continue; } catch {}
    }
    let stat = null;
    try { stat = fs.statSync(host); } catch {} // a broken link
    entries.push({
      name: d.name, path: p.join(where.shown, d.name),
      kind: stat?.isDirectory() ? 'dir' : 'file',
      size: stat?.isFile() ? stat.size : null, mtime: stat?.mtimeMs ?? null,
      link: d.isSymbolicLink() || undefined,
    });
  }
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'zh-Hant', { numeric: true, sensitivity: 'base' }) : a.kind === 'dir' ? -1 : 1));
  return { entries, truncated: dirents.length > entries.length && entries.length >= MAX_ENTRIES };
}

// --- search ---------------------------------------------------------------------------------

let rgPath; // undefined: not looked for yet; null: none
function findRg() {
  if (rgPath !== undefined) return rgPath;
  if (process.env.IMNOTCC_RG && fs.existsSync(process.env.IMNOTCC_RG)) return (rgPath = process.env.IMNOTCC_RG);
  const names = process.platform === 'win32' ? ['rg.exe', 'rg'] : ['rg'];
  for (const d of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) for (const n of names) {
    const f = path.join(d, n);
    try { if (fs.statSync(f).isFile()) return (rgPath = f); } catch {}
  }
  return (rgPath = null);
}

/** Runs rg in `dir`, one callback per output line, until it ends, `stop()` is called or time runs out. */
function rgLines(dir, args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(findRg(), args, { cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let done = false;
    const stop = () => { if (!done) { done = true; child.kill(); } };
    const timer = setTimeout(stop, SEARCH_MS);
    readline.createInterface({ input: child.stdout }).on('line', (l) => { if (!done && onLine(l) === false) stop(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', () => { clearTimeout(timer); done = true; resolve(); });
  });
}

const COMMON = ['--hidden', '--glob', '!.git', '--no-messages', ...RG_EXCLUDES];

async function searchRg(where, p, q, mode) {
  const results = [];
  const shownOf = (rel) => p.join(where.shown, rel.replace(/^\.[\\/]/, '').replace(/\\/g, '/'));
  const keep = (rel) => !isSensitive(path.join(where.host, rel));
  const needle = q.toLowerCase();
  if (mode === 'name') {
    await rgLines(where.host, ['--files', ...COMMON], (rel) => {
      if (!path.basename(rel).toLowerCase().includes(needle) && !rel.replace(/\\/g, '/').toLowerCase().includes(needle)) return;
      if (keep(rel)) results.push({ path: shownOf(rel) });
      return results.length < MAX_RESULTS;
    });
  } else {
    await rgLines(where.host, ['--json', '-F', '-S', '--max-count', '5', '--max-filesize', '2M', '--max-columns', '300', ...COMMON, '--', q, '.'], (l) => {
      let m;
      try { m = JSON.parse(l); } catch { return; }
      if (m.type !== 'match') return;
      const rel = m.data.path.text;
      if (rel == null || !keep(rel)) return;
      results.push({ path: shownOf(rel), line: m.data.line_number, text: (m.data.lines.text ?? '').replace(/\r?\n$/, '').slice(0, 300) });
      return results.length < MAX_RESULTS;
    });
  }
  return results;
}

// Without rg: a plain walk, skipping .git and node_modules, with the same limits.
async function searchWalk(where, p, q, mode) {
  const results = [];
  const deadline = Date.now() + SEARCH_MS;
  const needle = q.toLowerCase();
  const caseful = q !== needle; // smart case, as rg -S
  const stack = [''];
  while (stack.length && results.length < MAX_RESULTS && Date.now() < deadline) {
    const rel = stack.pop();
    let dirents;
    try { dirents = await fs.promises.readdir(path.join(where.host, rel), { withFileTypes: true }); } catch { continue; }
    for (const d of dirents) {
      if (results.length >= MAX_RESULTS) break;
      const r = rel ? `${rel}/${d.name}` : d.name;
      const host = path.join(where.host, r);
      if (isSensitive(host)) continue;
      if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name)) stack.push(r); continue; }
      if (!d.isFile()) continue;
      if (mode === 'name') {
        if (r.toLowerCase().includes(needle)) results.push({ path: p.join(where.shown, r) });
        continue;
      }
      let buf;
      try { if ((await fs.promises.stat(host)).size > 2 * 1024 * 1024) continue; buf = await fs.promises.readFile(host); } catch { continue; }
      if (buf.subarray(0, 8192).includes(0)) continue;
      const lines = buf.toString('utf8').split(/\r?\n/);
      let hits = 0;
      for (let i = 0; i < lines.length && hits < 5 && results.length < MAX_RESULTS; i++) {
        if ((caseful ? lines[i] : lines[i].toLowerCase()).includes(caseful ? q : needle)) {
          hits++;
          results.push({ path: p.join(where.shown, r), line: i + 1, text: lines[i].slice(0, 300) });
        }
      }
    }
  }
  return results;
}

export function browseRoutes(app, { requireSession, wrap }) {
  // One folder's entries. `parent` is null at a drive's or the file system's root.
  app.get('/api/sessions/:id/tree', (req, res) => {
    const meta = requireSession(req, res);
    if (!meta) return;
    const where = folder(meta, req.query.path, res);
    if (!where) return;
    const p = sessionPath(meta.cwd);
    let listed;
    try { listed = listDir(where, p); } catch (e) { return res.status(400).json({ error: `打不開這個資料夾：${e.code ?? e.message}` }); }
    const parent = p.dirname(where.shown);
    res.json({ path: where.shown, parent: parent === where.shown ? null : parent, root: sessionPath(meta.cwd).resolve(meta.cwd), ...listed });
  });

  // Search under a folder (the session's own by default): `mode=name` for file names, otherwise
  // the files' text. Smart case; results capped at MAX_RESULTS.
  app.get('/api/sessions/:id/search', wrap(async (req, res) => {
    const meta = requireSession(req, res);
    if (!meta) return;
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q || q.length > 200) return res.status(400).json({ error: '請輸入要搜尋的文字。' });
    const where = folder(meta, req.query.path, res);
    if (!where) return;
    const mode = req.query.mode === 'name' ? 'name' : 'content';
    const p = sessionPath(meta.cwd);
    let results, engine = 'rg';
    if (findRg()) {
      try { results = await searchRg(where, p, q, mode); } catch { results = null; }
    }
    if (!results) { engine = 'walk'; results = await searchWalk(where, p, q, mode); }
    res.json({ path: where.shown, mode, engine, results, truncated: results.length >= MAX_RESULTS });
  }));
}
