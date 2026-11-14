// Claude Code's login on the server computer (Windows, and WSL when it is there), so the page can
// ask for a new sign-in instead of sending the user to a terminal.
import { get, post } from "./api";
import { onGlobal } from "./socket";
import { createStore } from "./store-core";

export type ClaudeTarget = "host" | "wsl";
export interface ClaudeLogin {
  loggedIn: boolean | null;
  /** A reply was refused for this login, though its credential is still stored. */
  expired?: boolean;
  email?: string;
  authMethod?: string;
  expiresAt?: string;
  error?: string;
}

export const claudeAuth = createStore<{ status: Partial<Record<ClaudeTarget, ClaudeLogin>>; dismissed: boolean }>({ status: {}, dismissed: false });

export const TARGET_LABEL: Record<ClaudeTarget, string> = { host: "Windows", wsl: "WSL" };

let started = false;
export function startClaudeAuth() {
  if (started) return;
  started = true;
  void refreshClaudeAuth(false);
  onGlobal((m) => {
    // A new failure shows the banner again even after it was dismissed.
    if (m.kind === "claude-auth") claudeAuth.set({ status: m.status, dismissed: false });
  });
}

export async function refreshClaudeAuth(force = true) {
  try {
    const r = await get<{ status: Partial<Record<ClaudeTarget, ClaudeLogin>> }>(`/api/claude-auth${force ? "?refresh=1" : ""}`);
    claudeAuth.set({ status: r.status });
  } catch { /* the banner stays as it was */ }
}

export const loggedOutTargets = (status: Partial<Record<ClaudeTarget, ClaudeLogin>>) =>
  (Object.keys(status) as ClaudeTarget[]).filter((t) => status[t]?.loggedIn === false);

export const startClaudeLogin = (target: ClaudeTarget) => post<{ url: string }>("/api/claude-auth/login", { target });
export async function submitClaudeCode(code: string) {
  const r = await post<{ status: Partial<Record<ClaudeTarget, ClaudeLogin>> }>("/api/claude-auth/code", { code });
  claudeAuth.set({ status: r.status });
}
export const cancelClaudeLogin = () => post("/api/claude-auth/cancel").catch(() => {});
