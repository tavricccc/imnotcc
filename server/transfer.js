// Files going in and out: an upload lands in the session folder's .imnotcc/uploads/ for Claude to
// read, and a folder comes back as a zip. Keys and credentials (sensitive.js) stay out of zips.
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ZipArchive } from 'archiver';
import * as wsl from './wsl.js';
import { locate } from './files.js';
import { isSensitive } from './sensitive.js';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_BYTES = 1024 * 1024 * 1024;
const MAX_ZIP_FILES = 50_000;
// Left out of a zip: history and installed packages, which can be rebuilt and are huge.
const ZIP_SKIP = new Set(['.git', 'node_modules']);

const sessionPath = (cwd) => (wsl.isWsl(cwd) ? path.posix : path.win32);

/** A file name safe on Windows and Linux, keeping its extension. */
export function safeName(raw) {
  const base = String(raw ?? '').split(/[\\/]/).pop().normalize('NFC')
    .replace(/[\x00-\x1f<>:"|?*]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(-120);
  const name = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(base) ? `_${base}` : base;
  return name || 'file';
}

const stamp = (d = new Date()) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;

/**
 * The session's upload folder, made on first use. A `*` .gitignore inside .imnotcc keeps the
 * whole folder out of git without touching the project's own .gitignore.
 */
function uploadDir(cwd) {
  const root = locate(cwd, cwd);
  const p = sessionPath(cwd);
  const dir = { shown: p.join(root.shown, '.imnotcc', 'uploads'), host: path.join(root.host, '.imnotcc', 'uploads') };
  fs.mkdirSync(dir.host, { recursive: true });
  const ignore = path.join(root.host, '.imnotcc', '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '# imnotcc uploads; not part of the project\n*\n');
  return dir;
}

export function transferRoutes(app, { requireSession, wrap }) {
  // The request body is the file's bytes; `name` its name. Answers with the path Claude reads it at.
  app.post('/api/sessions/:id/upload', wrap(async (req, res) => {
    const meta = requireSession(req, res);
    if (!meta) return;
    const length = Number(req.headers['content-length']);
    if (!Number.isFinite(length)) return res.status(411).json({ error: '缺少檔案大小。' });
    if (length > MAX_UPLOAD_BYTES) return res.status(413).json({ error: `檔案太大，上限是 ${MAX_UPLOAD_BYTES / 1024 / 1024} MB。` });
    const name = safeName(req.query.name);
    if (isSensitive(name)) return res.status(400).json({ error: '這種檔案可能含有金鑰或密碼，不能上傳。' });
    let dir;
    try { dir = uploadDir(meta.cwd); } catch (e) { return res.status(500).json({ error: `建立上傳資料夾失敗：${e.code ?? e.message}` }); }
    const file = `${stamp()}-${name}`;
    const host = path.join(dir.host, file);
    let received = 0;
    const counter = async function* (src) {
      for await (const chunk of src) {
        received += chunk.length;
        if (received > MAX_UPLOAD_BYTES) throw Object.assign(new Error('too large'), { code: 'TOO_LARGE' });
        yield chunk;
      }
    };
    try {
      await pipeline(req, counter, fs.createWriteStream(host, { flags: 'wx' }));
    } catch (e) {
      fs.rmSync(host, { force: true });
      if (e.code === 'TOO_LARGE') return res.status(413).json({ error: '檔案太大。' });
      if (e.code === 'EEXIST') return res.status(409).json({ error: '同名檔案剛上傳過，請再試一次。' });
      if (!res.headersSent && !req.destroyed) return res.status(500).json({ error: `儲存失敗：${e.code ?? e.message}` });
      return;
    }
    res.json({ path: sessionPath(meta.cwd).join(dir.shown, file), name, size: received });
  }));

  // A folder as a zip, streamed. .git, node_modules and keys are left out; links are not followed.
  app.get('/api/sessions/:id/zip', wrap(async (req, res) => {
    const meta = requireSession(req, res);
    if (!meta) return;
    const where = locate(meta.cwd, typeof req.query.path === 'string' && req.query.path ? req.query.path : meta.cwd);
    let stat;
    try { stat = where && fs.statSync(where.host); } catch {}
    if (!stat?.isDirectory()) return res.status(404).json({ error: '找不到這個資料夾。' });
    let real = where.host;
    try { real = fs.realpathSync(where.host); } catch {}
    if (isSensitive(where.host) || isSensitive(real)) return res.status(403).json({ error: '這個資料夾可能含有金鑰或密碼，不能下載。' });

    // Gather first, so a folder too large is refused before any bytes are sent.
    const files = [];
    let total = 0;
    const stack = [''];
    while (stack.length) {
      const rel = stack.pop();
      let dirents;
      try { dirents = await fs.promises.readdir(path.join(real, rel), { withFileTypes: true }); } catch { continue; }
      for (const d of dirents) {
        const r = rel ? `${rel}/${d.name}` : d.name;
        const host = path.join(real, r);
        if (isSensitive(host)) continue;
        if (d.isDirectory()) { if (!ZIP_SKIP.has(d.name)) stack.push(r); continue; }
        if (!d.isFile()) continue;
        let s;
        try { s = await fs.promises.stat(host); } catch { continue; }
        files.push({ rel: r, host, mtime: s.mtime });
        total += s.size;
        if (total > MAX_ZIP_BYTES || files.length > MAX_ZIP_FILES) {
          return res.status(413).json({ error: `資料夾太大（超過 ${MAX_ZIP_BYTES / 1024 / 1024 / 1024} GB 或 ${MAX_ZIP_FILES} 個檔案），請挑小一點的資料夾。` });
        }
      }
    }

    const name = `${safeName(path.basename(real)) || 'folder'}.zip`;
    res.attachment(name).set({ 'Content-Type': 'application/zip', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    const zip = new ZipArchive({ zlib: { level: 6 } });
    zip.on('warning', () => {}); // a file that vanished meanwhile is skipped
    zip.on('error', () => res.destroy());
    res.on('close', () => { if (!res.writableFinished) zip.abort(); });
    zip.pipe(res);
    for (const f of files) zip.file(f.host, { name: f.rel, date: f.mtime });
    await zip.finalize();
  }));
}
