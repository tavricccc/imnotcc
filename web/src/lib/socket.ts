// One socket for the page. Sessions are subscribed by id; after a reconnect every subscription
// is sent again and the server answers each with a fresh snapshot.
import { createStore } from "./store-core";

export const conn = createStore({ online: false, everConnected: false });
type Listener = (m: any) => void;
const bySession = new Map<string, Set<Listener>>();
const everyone = new Set<Listener>();
const starting = new Map<string, (error?: Error) => void>();
let ws: WebSocket | null = null;
let retry = 0;

function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => {
    conn.set({ online: true, everConnected: true });
    retry = 0;
    for (const id of bySession.keys()) raw({ t: "sub", session: id });
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.kind === "started" || m.kind === "start-error") {
      starting.get(m.session)?.(m.kind === "start-error" ? new SessionStartRejected(m.message) : undefined);
      return;
    }
    if (m.session === null) for (const fn of everyone) fn(m);
    else for (const fn of bySession.get(m.session) ?? []) fn(m);
  };
  ws.onclose = () => {
    conn.set({ online: false });
    ws = null;
    for (const finish of starting.values()) finish(new Error("連線已中斷。重新送出以確認這則訊息。"));
    setTimeout(connect, Math.min(1000 * 2 ** retry++, 15_000));
  };
}

function raw(m: object) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(m));
    return true;
  }
  return false;
}

export function start() {
  if (!ws) connect();
}

export function subscribe(session: string, fn: Listener) {
  if (!bySession.has(session)) bySession.set(session, new Set());
  bySession.get(session)!.add(fn);
  raw({ t: "sub", session });
  return () => {
    const set = bySession.get(session);
    set?.delete(fn);
    if (set && !set.size) {
      bySession.delete(session);
      raw({ t: "unsub", session });
    }
  };
}

export function onGlobal(fn: Listener) {
  everyone.add(fn);
  return () => void everyone.delete(fn);
}

/** False when offline, so the caller can keep the user's text. */
export const send = (session: string, m: object) => raw({ session, ...m });

/** The server rejected this draft, so it is safe to edit before trying again. */
export class SessionStartRejected extends Error {}

export function startSession(session: string, prompt: object) {
  const message = JSON.stringify({ ...prompt, session, t: "start" });
  if (new TextEncoder().encode(message).length > 24 * 1024 * 1024) {
    return Promise.reject(new SessionStartRejected("附件太大，請移除部分圖片後重試。"));
  }
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      starting.delete(session);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error("伺服器尚未回覆。重新送出以確認這則訊息。")), 15_000);
    starting.set(session, finish);
    if (ws?.readyState === WebSocket.OPEN) ws.send(message);
    else finish(new Error("尚未連線，請再試一次。"));
  });
}
