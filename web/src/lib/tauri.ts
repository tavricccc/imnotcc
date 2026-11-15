import * as React from "react";

export interface DesktopConfig {
  url: string | null;
  local: boolean;
  installed_version: string | null;
  port: number;
  origins: string[];
  remote_url?: string | null;
}

export interface DesktopState {
  config: DesktopConfig;
  node: { Ok: string } | { Err: string };
  needs_update: boolean;
  needs_deps_install: boolean;
  local_url: string;
  autostart: boolean;
  data_dir: string;
  log_dir: string;
  has_password: boolean;
  server_running: boolean;
  app_version: string;
}

interface TauriGlobal {
  core?: {
    invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  };
  event?: {
    listen: <T = unknown>(event: string, cb: (e: { payload: T }) => void) => Promise<() => void>;
  };
}

function getTauri(): TauriGlobal | null {
  const g = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  return g?.core?.invoke ? g : null;
}

export function isTauri(): boolean {
  return !!getTauri();
}

export async function tauriInvoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const t = getTauri();
  if (!t?.core) throw new Error("不在桌面端環境");
  return t.core.invoke<T>(cmd, args);
}

export async function tauriListen<T = unknown>(event: string, cb: (payload: T) => void): Promise<() => void> {
  const t = getTauri();
  if (!t?.event) return () => {};
  return t.event.listen<T>(event, (e) => cb(e.payload));
}

let localHostPromise: Promise<boolean> | null = null;
let cachedLocalHost: boolean | null = null;

/** True when running inside the Tauri desktop app configured as a local server (Host). */
export function useIsLocalHost(): boolean {
  const [local, setLocal] = React.useState(() => (isTauri() ? cachedLocalHost ?? false : false));
  React.useEffect(() => {
    if (!isTauri()) return;
    if (cachedLocalHost !== null) {
      setLocal(cachedLocalHost);
      return;
    }
    localHostPromise ??= tauriInvoke<DesktopState>("get_state")
      .then((st) => {
        cachedLocalHost = !!st.config.local;
        return cachedLocalHost;
      })
      .catch(() => false);
    let live = true;
    void localHostPromise.then((v) => { if (live) setLocal(v); });
    return () => { live = false; };
  }, []);
  return local;
}
