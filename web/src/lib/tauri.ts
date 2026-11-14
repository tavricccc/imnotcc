export interface DesktopConfig {
  url: string | null;
  local: boolean;
  installed_version: string | null;
  port: number;
  origins: string[];
}

export interface DesktopState {
  config: DesktopConfig;
  node: { Ok: string } | { Err: string };
  needs_update: boolean;
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
