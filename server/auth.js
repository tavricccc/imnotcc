// One user, one password. A signed cookie carries the login; the Cloudflare Access policy in
// front of the tunnel is the first line, this is the second.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ALLOWED_ORIGINS, DATA_DIR } from './config.js';
import * as store from './state.js';

const COOKIE = 'ccr';
const MAX_AGE_S = 60 * 60 * 24 * 30;
const hashOf = (password, salt) => crypto.scryptSync(password, salt, 32).toString('hex');

// First start: take CC_REMOTE_PASSWORD, or make one and leave it in data/password.txt.
export function ensureAuth() {
  const s = store.get();
  if (s.auth) return;
  let password = process.env.CC_REMOTE_PASSWORD;
  if (!password) {
    password = crypto.randomBytes(9).toString('base64url');
    fs.writeFileSync(path.join(DATA_DIR, 'password.txt'), `${password}\n`, { mode: 0o600 });
    console.log(`[imnotcc] new password written to ${path.join(DATA_DIR, 'password.txt')}`);
  }
  setPassword(password);
}

export function setPassword(password) {
  const s = store.get();
  const salt = crypto.randomBytes(16).toString('hex');
  // A new secret signs every existing login out.
  s.auth = { salt, hash: hashOf(password, salt), secret: crypto.randomBytes(32).toString('hex') };
  store.save();
}

export function checkPassword(password) {
  const { salt, hash } = store.get().auth;
  const given = Buffer.from(hashOf(String(password ?? ''), salt), 'hex');
  return crypto.timingSafeEqual(given, Buffer.from(hash, 'hex'));
}

const sign = (value) => crypto.createHmac('sha256', store.get().auth.secret).update(value).digest('base64url');

export function issueCookie(res, secure) {
  const exp = String(Math.floor(Date.now() / 1000) + MAX_AGE_S);
  const flags = [`${COOKIE}=${exp}.${sign(exp)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${MAX_AGE_S}`];
  if (secure) flags.push('Secure');
  res.setHeader('Set-Cookie', flags.join('; '));
}

export function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

export function isAuthed(req) {
  const raw = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return false;
  const [exp, mac] = raw.slice(COOKIE.length + 1).split('.');
  if (!exp || !mac || Number(exp) * 1000 < Date.now()) return false;
  const want = Buffer.from(sign(exp));
  const got = Buffer.from(mac);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// Requests that change state, and every socket, must come from this site.
export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return req.method === 'GET';
  if (ALLOWED_ORIGINS.has(origin)) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

// Five wrong passwords a minute, then wait.
const failures = [];
export function loginAllowed() {
  const now = Date.now();
  while (failures.length && now - failures[0] > 60_000) failures.shift();
  return failures.length < 5;
}
export function noteFailure() { failures.push(Date.now()); }
