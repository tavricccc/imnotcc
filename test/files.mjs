// Checks the file browser, search, uploads and downloads without running a Claude turn.
// Starts its own server on a spare port with a throwaway data folder.
//   node test/files.mjs           (search through rg when it is on PATH)
//   node test/files.mjs --no-rg   (the plain walk rg falls back to)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 4292;
const BASE = `http://127.0.0.1:${PORT}`;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-data-'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-work-'));
const PASSWORD = 'files-test-password';
const NO_RG = process.argv.includes('--no-rg');

const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, ...(NO_RG ? { PATH: path.dirname(process.execPath), IMNOTCC_RG: '' } : {}), IMNOTCC_PORT: String(PORT), IMNOTCC_DATA_DIR: data, IMNOTCC_PASSWORD: PASSWORD },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(); });
  server.on('exit', (c) => reject(new Error(`server exited ${c}`)));
});

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) failed++; };
let cookie = '';
const api = async (method, url, body) => {
  const r = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: body ? JSON.stringify(body) : undefined });
  const setCookie = r.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
};

try {
  await api('POST', '/api/login', { password: PASSWORD });
  await api('POST', '/api/folders', { path: work });
  const { body: { id } } = await api('POST', '/api/sessions', { cwd: work });
  const S = `/api/sessions/${id}`;
  fs.mkdirSync(path.join(work, 'src'));
  fs.writeFileSync(path.join(work, 'src', 'main.js'), 'const needle = 42;\nconsole.log(needle);\n');
  fs.writeFileSync(path.join(work, 'README.md'), '# hi\n');
  fs.writeFileSync(path.join(work, '.env'), 'TOKEN=needle-secret\n');
  fs.writeFileSync(path.join(work, '.env.example'), 'TOKEN=\n');
  fs.writeFileSync(path.join(work, 'server.key'), 'needle');

  const tree = await api('GET', `${S}/tree`);
  const names = tree.body?.entries?.map((e) => e.name) ?? [];
  check('tree lists the session folder', tree.status === 200 && names[0] === 'src' && names.includes('README.md'), names.join(','));
  check('tree hides secrets', !names.includes('.env') && !names.includes('server.key') && names.includes('.env.example'));
  check('tree has a parent', !!tree.body?.parent);
  const sub = await api('GET', `${S}/tree?path=src`);
  check('tree of a subfolder', sub.body?.entries?.[0]?.name === 'main.js');
  check('tree of a missing folder is 404', (await api('GET', `${S}/tree?path=nope`)).status === 404);
  check('tree of ~/.ssh is refused', (await api('GET', `${S}/tree?path=${encodeURIComponent(path.join(os.homedir(), '.ssh'))}`)).status === 403 || !fs.existsSync(path.join(os.homedir(), '.ssh')));
  check('tree of the data folder is refused', (await api('GET', `${S}/tree?path=${encodeURIComponent(data)}`)).status === 403);

  check('file .env is refused', (await api('GET', `${S}/file?path=.env`)).status === 403);
  check('raw server.key is refused', (await fetch(`${BASE}${S}/raw?path=server.key`, { headers: { cookie } })).status === 403);
  check('file README.md is read', (await api('GET', `${S}/file?path=README.md`)).body?.text === '# hi\n');
  const resolved = await api('POST', `${S}/resolve`, { paths: ['.env', 'README.md'] });
  check('resolve leaves secrets out', resolved.body?.files?.[0] === null && !!resolved.body?.files?.[1]);

  const content = await api('GET', `${S}/search?q=needle`);
  const hits = content.body?.results ?? [];
  check('content search finds matches', hits.length === 2 && hits.every((h) => h.path.endsWith('main.js')), `${content.body?.engine}: ${JSON.stringify(hits)}`);
  check('search engine', content.body?.engine === (NO_RG ? 'walk' : 'rg'), content.body?.engine);
  check('content search has line numbers', hits[0]?.line === 1 && hits[0]?.text.includes('needle'));
  const byName = await api('GET', `${S}/search?q=main&mode=name`);
  check('name search', byName.body?.results?.length === 1, JSON.stringify(byName.body?.results));
  check('empty search is refused', (await api('GET', `${S}/search?q=`)).status === 400);

  // Uploads
  const up = (name, body, headers = {}) => fetch(`${BASE}${S}/upload?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { origin: BASE, cookie, 'content-type': 'application/octet-stream', ...headers }, body });
  const r1 = await up('../../evil name?.log', 'hello log');
  const u1 = await r1.json();
  check('upload lands in .imnotcc/uploads', r1.status === 200 && u1.path.startsWith(path.join(work, '.imnotcc', 'uploads')) && fs.readFileSync(u1.path, 'utf8') === 'hello log', JSON.stringify(u1));
  check('upload has a relative path', u1.relative === `.imnotcc/uploads/${path.basename(u1.path)}`, u1.relative);
  check('upload name is cleaned', /^\d{8}-\d{6}-evil name_\.log$/.test(path.basename(u1.path)), path.basename(u1.path));
  check('upload folder ignored by git', fs.readFileSync(path.join(work, '.imnotcc', '.gitignore'), 'utf8').includes('*'));
  check('upload of a key is refused', (await up('id_rsa', 'x')).status === 400);
  check('upload without origin is refused', (await fetch(`${BASE}${S}/upload?name=a.txt`, { method: 'POST', headers: { cookie }, body: 'x' })).status === 403);
  const big = await up('big.bin', Buffer.alloc(50 * 1024 * 1024 + 1));
  check('upload over the limit is refused', big.status === 413, String(big.status));
  check('nothing kept from a refused upload', !fs.readdirSync(path.join(work, '.imnotcc', 'uploads')).some((f) => f.endsWith('big.bin')));

  // Zip
  const z = await fetch(`${BASE}${S}/zip`, { headers: { cookie } });
  const zbuf = Buffer.from(await z.arrayBuffer());
  const zipNames = zbuf.toString('latin1');
  check('zip downloads', z.status === 200 && z.headers.get('content-type') === 'application/zip' && zbuf.subarray(0, 2).toString() === 'PK');
  check('zip has the files', zipNames.includes('src/main.js') && zipNames.includes('README.md'));
  check('zip leaves secrets out', !zipNames.includes('server.key') && !/\.env[^.]/.test(zipNames.replace('.env.example', '')));
  check('zip of a missing folder is 404', (await fetch(`${BASE}${S}/zip?path=nope`, { headers: { cookie } })).status === 404);
} catch (e) {
  console.error(e);
  failed++;
} finally {
  server.kill();
  fs.rmSync(data, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
