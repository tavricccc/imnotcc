// End-to-end check of the server against the real Claude Code (uses haiku; a few small turns).
// Starts its own server on a spare port with a throwaway data folder.
//   node test/smoke.mjs          (Windows folder)
//   node test/smoke.mjs --wsl    (a folder inside WSL; Claude Code runs there)
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const PORT = 4291;
const BASE = `http://127.0.0.1:${PORT}`;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-data-'));
const WSL = process.argv.includes('--wsl');
const DISTRO = process.env.IMNOTCC_WSL_DISTRO || 'Ubuntu';
// `work` is the session's folder; `local` is the same folder as this script opens it.
const work = WSL ? execFileSync('wsl.exe', ['-d', DISTRO, '-e', 'mktemp', '-d', '/tmp/ccr-work-XXXXXX'], { encoding: 'utf8' }).trim()
  : fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-work-'));
const local = WSL ? `//wsl.localhost/${DISTRO}${work}` : work;
const PASSWORD = 'smoke-test-password';

const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, IMNOTCC_PORT: String(PORT), IMNOTCC_DATA_DIR: data, IMNOTCC_PASSWORD: PASSWORD },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => { process.stdout.write(d); if (String(d).includes('listening')) resolve(); });
  server.on('exit', (c) => reject(new Error(`server exited ${c}`)));
});

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) failed++; };
let cookie = '';
const api = async (method, url, body) => {
  const r = await fetch(BASE + url, {
    method, headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = r.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
};

try {
  check('unauthenticated is refused', (await api('GET', '/api/sessions')).status === 401);
  check('wrong password is refused', (await api('POST', '/api/login', { password: 'nope' })).status === 401);
  check('login', (await api('POST', '/api/login', { password: PASSWORD })).status === 200);
  check('foreign origin is refused', (await fetch(BASE + '/api/folders', { method: 'POST', headers: { origin: 'https://evil.example', cookie, 'content-type': 'application/json' }, body: '{}' })).status === 403);
  check('add folder', (await api('POST', '/api/folders', { path: work })).body?.folders?.length === 1);
  const { body: { id } } = await api('POST', '/api/sessions', { cwd: work });
  check('create session', !!id);
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  fs.writeFileSync(path.join(local, 'shot.png'), PNG);
  fs.writeFileSync(path.join(local, 'notes.txt'), 'secret');
  const image = (p) => fetch(`${BASE}/api/sessions/${id}/image?path=${encodeURIComponent(p)}`, { headers: { cookie } });
  const shot = await image('shot.png');
  check('image by relative path', shot.status === 200 && shot.headers.get('content-type') === 'image/png' && Buffer.from(await shot.arrayBuffer()).equals(PNG));
  check('image by absolute path', (await image(`${work}/shot.png`)).status === 200);
  check('non-image refused', (await image('notes.txt')).status === 403);
  check('image outside folder', (await image(path.resolve('web/public/icon-192.png'))).status === 200);
  check('text file outside folder refused', (await image(path.resolve('package.json'))).status === 403);
  check('missing image', (await image('nope.png')).status === 404);
  check('image needs login', (await fetch(`${BASE}/api/sessions/${id}/image?path=shot.png`)).status === 401);

  // Files named in a reply: which exist, their text, their bytes.
  fs.writeFileSync(path.join(local, 'README.md'), '# hi\n');
  const resolved = (await api('POST', `/api/sessions/${id}/resolve`, { paths: ['README.md', 'shot.png', 'nope.ts', `${work}/notes.txt`, '.'] })).body?.files ?? [];
  check('resolve kinds', resolved.map((f) => f?.kind ?? null).join() === 'markdown,image,,text,dir', JSON.stringify(resolved.map((f) => f?.kind ?? null)));
  check('resolve gives the session path', resolved[0]?.path === (WSL ? `${work}/README.md` : path.join(work, 'README.md')), resolved[0]?.path);
  const md = await api('GET', `/api/sessions/${id}/file?path=README.md`);
  check('file text', md.status === 200 && md.body.text === '# hi\n');
  check('file outside folder', (await api('GET', `/api/sessions/${id}/file?path=${encodeURIComponent(path.resolve('package.json'))}`)).body?.kind === 'text');
  check('binary file has no text', (await api('GET', `/api/sessions/${id}/file?path=shot.png`)).body?.text === undefined);
  check('missing file', (await api('GET', `/api/sessions/${id}/file?path=nope.ts`)).status === 404);
  const rawText = await fetch(`${BASE}/api/sessions/${id}/raw?path=notes.txt`, { headers: { cookie } });
  check('raw non-image is a download', rawText.status === 200 && rawText.headers.get('content-type') === 'application/octet-stream' && /attachment/.test(rawText.headers.get('content-disposition') ?? ''));
  check('raw needs login', (await fetch(`${BASE}/api/sessions/${id}/raw?path=notes.txt`)).status === 401);
  // A local HTML page opens in a new tab through a token, sandboxed, limited to its folder.
  fs.mkdirSync(path.join(local, 'site'));
  fs.writeFileSync(path.join(local, 'site', 'index.html'), '<script src="app.js"></script>');
  fs.writeFileSync(path.join(local, 'site', 'app.js'), 'console.log(1)');
  check('preview link only for html', (await api('POST', `/api/sessions/${id}/preview-link`, { path: 'notes.txt' })).status === 400);
  const link = (await api('POST', `/api/sessions/${id}/preview-link`, { path: 'site/index.html' })).body?.url ?? '';
  const page = await fetch(BASE + link);
  check('preview page without login', page.status === 200 && /sandbox allow-scripts/.test(page.headers.get('content-security-policy') ?? '') && !/allow-same-origin/.test(page.headers.get('content-security-policy') ?? ''));
  check('preview sibling asset', (await fetch(BASE + link.replace(/[^/]+$/, 'app.js'))).status === 200);
  check('preview cannot leave its folder', [403, 404].includes((await fetch(BASE + link.replace(/[^/]+$/, '..%2fnotes.txt'))).status));
  check('preview bad token', (await fetch(`${BASE}/preview/nope/index.html`)).status === 404);

  const gitArgs = (args) => (WSL ? ['wsl.exe', ['-d', DISTRO, '--cd', work, '-e', 'git', ...args]] : ['git', args, { cwd: work }]);
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']]) {
    const [file, argv, opts] = gitArgs(args);
    execFileSync(file, argv, { ...opts, stdio: 'ignore' });
  }

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie, origin: BASE } });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  const events = [];
  let sawDelta = false;
  const waiters = [];
  ws.on('message', (raw) => {
    const e = JSON.parse(raw);
    if (e.kind === 'delta') sawDelta = true;
    if (e.kind === 'sdk' && e.msg.type === 'assistant') for (const c of e.msg.message.content) if (c.type === 'text') console.log('  claude:', c.text.slice(0, 160));
    const w = waiters.find((x) => x.test(e));
    if (w) { waiters.splice(waiters.indexOf(w), 1); w.resolve(e); } else events.push(e);
  });
  const wait = (test, ms = 120_000) => new Promise((resolve, reject) => {
    const hit = events.find(test); if (hit) { events.splice(events.indexOf(hit), 1); return resolve(hit); }
    const t = setTimeout(() => reject(new Error('timeout waiting')), ms);
    waiters.push({ test, resolve: (e) => { clearTimeout(t); resolve(e); } });
  });
  const sendWs = (m) => ws.send(JSON.stringify({ session: id, ...m }));
  const isResult = (e) => e.kind === 'sdk' && e.msg.type === 'result';

  sendWs({ t: 'sub' });
  check('snapshot on subscribe', (await wait((e) => e.kind === 'snapshot')).status === 'idle');
  sendWs({ t: 'model', model: 'haiku' });
  await wait((e) => e.kind === 'model');

  // Turn 1: bypass, a file gets written.
  sendWs({ t: 'mode', mode: 'bypassPermissions' });
  await wait((e) => e.kind === 'mode');
  const turn1 = crypto.randomUUID();
  sendWs({ t: 'send', uuid: turn1, text: 'Use Bash to run: echo hi > a.txt . Then reply only DONE.' });
  const r1 = await wait(isResult);
  check('bypass turn', r1.msg.subtype === 'success' && fs.existsSync(path.join(local, 'a.txt')));
  const changed = await wait((e) => e.kind === 'changes' && e.uuid === turn1, 60_000).catch(() => null);
  check('turn changes', changed?.files?.some((f) => f.path === 'a.txt'), JSON.stringify(changed?.files));
  const d = await api('GET', `/api/sessions/${id}/diff?turn=${turn1}&path=a.txt`);
  check('turn diff', d.status === 200 && /\+hi/.test(d.body?.patch ?? ''), d.body?.error);
  check('diff of a file the turn did not change', (await api('GET', `/api/sessions/${id}/diff?turn=${turn1}&path=README.md`)).status === 404);
  check('streamed text', sawDelta);
  const ctx = await wait((e) => e.kind === 'context', 30_000).catch(() => null);
  check('context usage', !!ctx?.context?.max, ctx ? `${ctx.context.used}/${ctx.context.threshold}` : 'none');
  const plan = await wait((e) => e.kind === 'plan', 30_000).catch(() => null);
  check('plan usage (experimental)', plan !== null, JSON.stringify(plan?.plan));
  sendWs({ t: 'usage' });
  check('usage on demand', !!(await wait((e) => e.kind === 'context', 30_000).catch(() => null)));
  check('plan on demand (http)', 'plan' in ((await api('GET', '/api/usage?refresh=1')).body ?? {}));

  // Effort between turns restarts the process and resumes the same conversation.
  sendWs({ t: 'effort', effort: 'low' });
  check('effort refused without restart', (await wait((e) => e.kind === 'error')).message.includes('重新啟動'));
  sendWs({ t: 'effort', effort: 'low', restart: true });
  await wait((e) => e.kind === 'closed');
  check('effort applied after restart', (await wait((e) => e.kind === 'effort')).effort === 'low');
  sendWs({ t: 'send', text: 'What file name did you write in the previous turn? Reply with only the name.' });
  const re = await wait(isResult);
  check('resumed after effort restart', re.msg.subtype === 'success' && /a\.txt/.test(re.msg.result ?? ''), re.msg.result);

  // Turn 2: default mode, the permission request comes to the socket and is denied.
  sendWs({ t: 'mode', mode: 'default' });
  await wait((e) => e.kind === 'mode');
  sendWs({ t: 'send', text: 'Use Bash to run: echo x > b.txt . Then reply only DONE.' });
  const perm = await wait((e) => e.kind === 'permission');
  check('permission request', perm.tool === 'Bash');
  sendWs({ t: 'answer', id: perm.id, decision: 'deny' });
  await wait(isResult);
  check('denied tool did not run', !fs.existsSync(path.join(local, 'b.txt')));

  // Turn 3: allowed this time.
  sendWs({ t: 'send', text: 'New request, unrelated to the last one: use the Bash tool to run `echo y > c.txt`. Reply DONE.' });
  const perm2 = await wait((e) => e.kind === 'permission' || isResult(e));
  if (perm2.kind === 'permission') { sendWs({ t: 'answer', id: perm2.id, decision: 'allow' }); await wait(isResult); }
  check('allowed tool ran', fs.existsSync(path.join(local, 'c.txt')));

  const list = await api('GET', '/api/sessions');
  check('session listed with title', list.body.groups[0]?.sessions[0]?.id === id, list.body.groups[0]?.sessions[0]?.title);
  const hist = await api('GET', `/api/sessions/${id}/messages?limit=3`);
  check('history paging', hist.body.messages.length === 3 && hist.body.total > 3, `total ${hist.body.total}`);
  const controls = await api('GET', '/api/controls');
  check('commands cached', controls.body.controls?.commands?.some((c) => c.name === 'compact'));
  const fork = await api('POST', `/api/sessions/${id}/fork`);
  check('fork', !!fork.body.id && fork.body.id !== id);
  check('rename', (await api('POST', `/api/sessions/${id}/rename`, { title: 'smoke' })).status === 200);
  check('renamed title', (await api('GET', `/api/sessions/${id}`)).body.title === 'smoke');

  // Sending while a turn runs: "queue" holds the prompt until the turn ends, then sends it.
  sendWs({ t: 'mode', mode: 'bypassPermissions' });
  await wait((e) => e.kind === 'mode');
  for (let e; (e = events.find((x) => x.kind === 'queued' || x.kind === 'status'));) events.splice(events.indexOf(e), 1);
  sendWs({ t: 'send', uuid: crypto.randomUUID(), text: 'Use Bash to run: sleep 8 . Then reply only SLEPT.' });
  await wait((e) => e.kind === 'status' && e.status === 'running');
  const held = crypto.randomUUID();
  sendWs({ t: 'send', uuid: held, queue: true, text: 'Reply only QUEUED.' });
  check('queued while running', (await wait((e) => e.kind === 'queued' && e.queued.length === 1)).queued[0].uuid === held);
  const slept = await wait(isResult);
  const out = await wait((e) => e.kind === 'dequeued', 30_000).catch(() => null);
  check('held prompt waits for the turn', slept.msg.subtype === 'success' && out?.uuid === held);
  const queuedResult = await wait(isResult);
  check('held prompt runs as its own turn', /QUEUED/.test(queuedResult.msg.result ?? ''), queuedResult.msg.result);

  // A stopped turn hands held prompts back instead of sending them.
  events.length = 0;
  sendWs({ t: 'send', uuid: crypto.randomUUID(), text: 'Use Bash to run: sleep 30 . Then reply only SLEPT.' });
  // Queue and stop only once the sleep is under way, so the turn cannot end first on its own.
  await wait((e) => e.kind === 'sdk' && e.msg.type === 'assistant' && e.msg.message.content.some((c) => c.type === 'tool_use'));
  const held2 = crypto.randomUUID();
  sendWs({ t: 'send', uuid: held2, queue: true, text: 'Reply only SHOULD-NOT-RUN.' });
  await wait((e) => e.kind === 'queued' && e.queued.length === 1);
  sendWs({ t: 'interrupt' });
  const back = await wait((e) => e.kind === 'queue-returned', 60_000).catch(() => null);
  if (!back) console.log('  after interrupt:', JSON.stringify(events.map((e) => e.kind === 'sdk' ? 'sdk:' + e.msg.type + ':' + (e.msg.subtype ?? '') : e.kind + (e.status ? ':' + e.status : '') + (e.uuid ? ':' + e.uuid.slice(0, 4) : ''))));
  check('interrupt returns held prompts', back?.items?.[0]?.uuid === held2 && back.items[0].text === 'Reply only SHOULD-NOT-RUN.');
  await new Promise((r) => setTimeout(r, 3000));
  check('returned prompt was not sent', !events.some((e) => e.kind === 'dequeued'));
  ws.close();
} catch (e) {
  console.error(e);
  failed++;
} finally {
  server.kill();
  fs.rmSync(data, { recursive: true, force: true });
  // Claude Code may still hold the folder open on Windows; a leftover temp folder is fine.
  try { fs.rmSync(local, { recursive: true, force: true }); } catch {}
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
