// Page-wide state: plan usage, the cached slash commands and models, and running sessions.
import { get } from "./api";
import { onGlobal } from "./socket";
import { createStore } from "./store-core";

export interface PlanWindow { pct: number; resetsAt?: string }
export interface Plan { fiveHour?: PlanWindow; sevenDay?: PlanWindow }
export interface Controls {
  commands: { name: string; description?: string; argumentHint?: string }[];
  models: { value: string; displayName?: string; description?: string; resolvedModel?: string; supportsEffort?: boolean; supportedEffortLevels?: string[] }[];
}

export const shared = createStore<{ plan: Plan | null; controls: Controls | null; running: Record<string, boolean> }>({
  plan: null,
  controls: null,
  running: {},
});

let started = false;
export function startShared() {
  if (started) return;
  started = true;
  // The saved reading shows at once; with none, or every 90 s while visible, a fresh one is read.
  const refresh = () => get("/api/usage?refresh=1").then((r) => shared.set({ plan: r.plan })).catch(() => {});
  get("/api/usage").then((r) => { shared.set({ plan: r.plan }); if (!r.plan) void refresh(); }).catch(() => void refresh());
  setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 90_000);
  get("/api/controls").then((r) => shared.set({ controls: r.controls })).catch(() => {});
  onGlobal((m) => {
    if (m.kind === "plan") shared.set({ plan: m.plan });
    if (m.kind === "controls") shared.set({ controls: m.controls });
    if (m.kind === "running") shared.set((s) => ({ running: { ...s.running, [m.session]: m.running } }));
  });
}

/** Commands that only work as a terminal menu: on the phone they point to a screen instead. */
export const TERMINAL_ONLY: Record<string, string | null> = {
  config: "設定", plugin: "擴充元件", plugins: "擴充元件", login: null, logout: null, resume: null, exit: null,
  quit: null, vim: null, terminal: null, "terminal-setup": null, ide: null, theme: null, doctor: null, permissions: null,
};
