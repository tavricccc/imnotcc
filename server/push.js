// Web Push: tells subscribed devices when a turn ends, Claude needs an answer, or a session fails.
// The VAPID key pair and the subscriptions live in state.json next to the rest of the app's data.
import path from 'node:path';
import * as webpush from 'web-push';
import * as store from './state.js';
import * as runners from './runner.js';

const SUBJECT = process.env.IMNOTCC_PUSH_SUBJECT || 'mailto:imnotcc@example.com';

function config() {
  const s = store.get();
  if (!s.push?.vapid) {
    s.push = { vapid: webpush.generateVAPIDKeys(), subs: s.push?.subs ?? [] };
    store.save();
  }
  return s.push;
}

const validSub = (sub) => typeof sub?.endpoint === 'string' && /^https:\/\//.test(sub.endpoint)
  && typeof sub.keys?.p256dh === 'string' && typeof sub.keys?.auth === 'string';

async function notify(payload) {
  const push = config();
  if (!push.subs.length) return;
  const body = JSON.stringify(payload);
  const gone = new Set();
  await Promise.all(push.subs.map((sub) => webpush.sendNotification(sub, body, {
    vapidDetails: { subject: SUBJECT, publicKey: push.vapid.publicKey, privateKey: push.vapid.privateKey },
    TTL: 3600, urgency: payload.urgency ?? 'normal', topic: payload.tag?.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || undefined,
  }).catch((e) => {
    if (e.statusCode === 404 || e.statusCode === 410) gone.add(sub.endpoint);
    else console.error('[imnotcc] push:', e.statusCode ?? '', e.body || e.message);
  })));
  if (gone.size) { push.subs = push.subs.filter((s) => !gone.has(s.endpoint)); store.save(); }
}

const clip = (text, n = 140) => { const t = String(text ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

function onRunnerEvent(id, event) {
  if (!id) return;
  const base = { session: id, url: `/s/${id}`, tag: `session-${id}` };
  if (event.kind === 'permission') {
    const question = event.tool === 'AskUserQuestion';
    const q = question ? event.input?.questions?.[0]?.question : null;
    void notify({ ...base, urgency: 'high', title: question ? 'Claude 在問你' : '需要你的確認', body: clip(q || `要使用 ${event.tool}`) });
  } else if (event.kind === 'sdk' && event.msg?.type === 'result') {
    const m = event.msg;
    const failed = m.subtype !== 'success' || m.is_error;
    void notify({ ...base, title: failed ? '發生錯誤' : '回合完成', body: clip(failed ? (m.errors?.join(' ') || m.result || m.subtype) : m.result) || '已完成' });
  } else if (event.kind === 'error') {
    void notify({ ...base, title: '發生錯誤', body: clip(event.message) });
  }
}

export function pushRoutes(app) {
  config();
  runners.onEvent(onRunnerEvent);
  app.get('/api/push/key', (_req, res) => res.json({ publicKey: config().vapid.publicKey }));
  app.post('/api/push/subscribe', (req, res) => {
    const sub = req.body?.subscription;
    if (!validSub(sub)) return res.status(400).json({ error: 'subscription' });
    const push = config();
    push.subs = [...push.subs.filter((s) => s.endpoint !== sub.endpoint), { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }];
    store.save();
    res.json({ ok: true });
  });
  app.post('/api/push/unsubscribe', (req, res) => {
    const push = config();
    const endpoint = req.body?.endpoint;
    push.subs = push.subs.filter((s) => s.endpoint !== endpoint);
    store.save();
    res.json({ ok: true });
  });
  app.post('/api/push/test', (_req, res) => { void notify({ title: '測試通知', body: '通知已開啟', url: '/', tag: 'test' }); res.json({ ok: true }); });
}
