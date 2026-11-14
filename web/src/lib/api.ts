import { createStore } from "./store-core";
import { clearCache } from "./cache";

export const auth = createStore({ checked: false, authed: false });
auth.subscribe(() => { if (!auth.get().authed) clearCache(); });

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && data.error === "login") auth.set({ authed: false });
  if (!r.ok) throw new Error(data.error || data.output || `${r.status} ${r.statusText}`);
  return data;
}

export const get = <T = any>(url: string) => api<T>("GET", url);
export const post = <T = any>(url: string, body: unknown = {}) => api<T>("POST", url, body);
export const put = <T = any>(url: string, body: unknown = {}) => api<T>("PUT", url, body);
export const del = <T = any>(url: string, body: unknown = {}) => api<T>("DELETE", url, body);
