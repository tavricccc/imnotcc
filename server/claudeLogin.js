// Claude Code's own login, run from the web page so nobody has to open a terminal on this computer.
// `claude auth login` prints a sign-in link and then reads the code from its input, which works
// through a pipe: the page shows the link, the user signs in anywhere, and pastes the code back.
// Windows sessions and WSL sessions each have their own login ("host" and "wsl").
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as store from './state.js';
import * as runners from './runner.js';
import * as wsl from './wsl.js';

const LOGIN_TIMEOUT = 10 * 60 * 1000;
const STATUS_TTL = 60 * 1000;
// Assistant errors that mean the login itself is gone, not a passing API problem.
const AUTH_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed']);

// The CLI the SDK runs, so this is the same binary and the same login as the sessions use.
let exe;
function claudeExe() {
  if (exe !== undefined) return exe;
  const require = createRequire(import.meta.url);
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const suffix of ['', '-musl']) {
    try {
      const dir = path.dirname(require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${suffix}/package.json`));
      if (fs.existsSync(path.join(dir, name))) return (exe = path.join(dir, name));
    } catch { /* not installed for this platform */ }
  }
  return (exe = 'claude');
}

const targets = () => (wsl.available() ? ['host', 'wsl'] : ['host']);

function run(target, args) {
  const opts = { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true };
  if (target === 'wsl') return spawn('wsl.exe', wsl.cliArgs(args), opts);
  return spawn(claudeExe(), args, { ...opts, env: wsl.spawnOptions(process.cwd()).env });
}

// ---- Status ----

const status = {}; // target -> { loggedIn, email, authMethod, expiresAt, failed, checkedAt, error }

function readStatus(target) {
  return new Promise((resolve) => {
    const p = run(target, ['auth', 'status', '--json']);
    let out = '';
    const timer = setTimeout(() => p.kill(), 20000);
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', (e) => { clearTimeout(timer); resolve({ loggedIn: null, error: e.message }); });
    p.on('close', () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out);
        resolve({ loggedIn: !!j.loggedIn, email: j.email, authMethod: j.authMethod, expiresAt: j.loginExpiresAt });
      } catch { resolve({ loggedIn: null, error: '讀不到 Claude Code 的登入狀態。' }); }
    });
  });
}

async function refresh(target, force) {
  const cur = status[target];
  if (!force && cur && Date.now() - cur.checkedAt < STATUS_TTL) return cur;
  const next = await readStatus(target);
  // A run that was refused keeps counting as logged out until a login succeeds, even though the
  // stored credential still reads as present.
  const failed = !!cur?.failed && next.loggedIn !== false;
  status[target] = { ...next, failed, checkedAt: Date.now() };
  return status[target];
}

const view = () => Object.fromEntries(targets().filter((t) => status[t]).map((t) => {
  const { loggedIn, email, authMethod, expiresAt, failed, error } = status[t];
  return [t, { loggedIn: failed ? false : loggedIn, expired: failed, email, authMethod, expiresAt, error }];
}));

const announce = () => runners.broadcast({ kind: 'claude-auth', status: view() });

// A refused reply marks that login as expired; a turn that ends well (say, after a login done in a
// terminal after all) clears it again.
runners.onEvent((id, event) => {
  if (id === null || event.kind !== 'sdk') return;
  const m = event.msg;
  const target = wsl.isWsl(store.get().sessions[id]?.cwd) ? 'wsl' : 'host';
  if (m?.type === 'assistant' && AUTH_ERRORS.has(m.error)) {
    status[target] = { ...(status[target] ?? { checkedAt: 0 }), failed: true };
    announce();
  } else if (m?.type === 'result' && !m.is_error && status[target]?.failed) {
    status[target] = { ...status[target], failed: false, loggedIn: true };
    announce();
  }
});

// ---- Login ----

let login = null; // { target, proc, out, timer }

function stopLogin() {
  if (!login) return;
  clearTimeout(login.timer);
  login.proc.kill();
  login = null;
}

function startLogin(target) {
  stopLogin();
  const proc = run(target, ['auth', 'login']);
  const current = { target, proc, out: '', exited: null };
  login = current;
  current.timer = setTimeout(() => { if (login === current) stopLogin(); }, LOGIN_TIMEOUT);
  const collect = (d) => { current.out += d; };
  proc.stdout.on('data', collect);
  proc.stderr.on('data', collect);
  current.done = new Promise((resolve) => {
    proc.on('error', (e) => { current.out += `\n${e.message}`; current.exited = -1; resolve(-1); });
    proc.on('close', (code) => { current.exited = code ?? -1; resolve(current.exited); });
  });
  return new Promise((resolve, reject) => {
    const end = Date.now() + 30000;
    const check = () => {
      const url = current.out.match(/https:\/\/\S+\/oauth\/authorize\?\S+/)?.[0];
      if (url) return resolve(url);
      if (current.exited !== null || Date.now() > end) {
        if (login === current) stopLogin();
        return reject(new Error(lastLine(current.out) || '沒有拿到登入連結。'));
      }
      setTimeout(check, 200);
    };
    check();
  });
}

const lastLine = (s) => s.split(/\r?\n/).map((l) => l.replace(/^.*>\s*/, '').trim()).filter(Boolean).pop();

async function submitCode(code) {
  const current = login;
  if (!current) throw new Error('登入流程已經結束，請重新開始。');
  current.proc.stdin.write(`${code}\n`);
  const exited = await Promise.race([current.done, new Promise((r) => setTimeout(() => r(null), 60000))]);
  if (login === current) { clearTimeout(current.timer); login = null; }
  if (exited !== 0) {
    current.proc.kill();
    throw new Error(lastLine(current.out) || '登入沒有成功，請重新取得連結再試一次。');
  }
  status[current.target] = { ...(status[current.target] ?? {}), failed: false };
  await refresh(current.target, true);
  announce();
}

const pickTarget = (t) => (targets().includes(t) ? t : 'host');

export function claudeLoginRoutes(app, wrap) {
  app.get('/api/claude-auth', wrap(async (req, res) => {
    await Promise.all(targets().map((t) => refresh(t, !!req.query.refresh)));
    res.json({ status: view(), pending: login?.target ?? null });
  }));
  app.post('/api/claude-auth/login', wrap(async (req, res) => {
    try { res.json({ url: await startLogin(pickTarget(req.body?.target)) }); }
    catch (e) { res.status(502).json({ error: e.message }); }
  }));
  app.post('/api/claude-auth/code', wrap(async (req, res) => {
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    if (!code || /\s/.test(code) || code.length > 2000) return res.status(400).json({ error: '請貼上登入頁面給的完整代碼。' });
    try { await submitCode(code); res.json({ status: view() }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  }));
  app.post('/api/claude-auth/cancel', (_req, res) => { stopLogin(); res.json({ ok: true }); });
}
