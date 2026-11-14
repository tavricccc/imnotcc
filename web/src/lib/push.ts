import { get, post } from "./api";
import { createStore } from "./store-core";

export type PushState = "unsupported" | "needs-install" | "denied" | "off" | "on";

const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
// iOS only offers Web Push to a site added to the Home Screen.
const needsInstall = () => /iP(hone|ad|od)/.test(navigator.userAgent) && !matchMedia("(display-mode: standalone)").matches;

export const push = createStore<{ state: PushState | null }>({ state: null });

async function subscription() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

export async function refreshPush() {
  if (!supported()) return push.set({ state: needsInstall() ? "needs-install" : "unsupported" });
  if (Notification.permission === "denied") return push.set({ state: "denied" });
  push.set({ state: (await subscription()) ? "on" : "off" });
}

function keyBytes(base64url: string) {
  const raw = atob(base64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "="));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function enablePush() {
  if ((await Notification.requestPermission()) !== "granted") return refreshPush();
  const { publicKey } = await get<{ publicKey: string }>("/api/push/key");
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with another server key can't be reused.
  if (sub && sub.options.applicationServerKey && new Uint8Array(sub.options.applicationServerKey).toString() !== keyBytes(publicKey).toString()) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await post("/api/push/subscribe", { subscription: sub.toJSON() });
  await refreshPush();
}

export async function disablePush() {
  const sub = await subscription();
  if (sub) {
    await post("/api/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe();
  }
  await refreshPush();
}

export const testPush = () => post("/api/push/test");
