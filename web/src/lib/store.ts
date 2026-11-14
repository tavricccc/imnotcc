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
  get("/api/usage").then((r) => shared.set({ plan: r.plan })).catch(() => {});
  get("/api/controls").then((r) => shared.set({ controls: r.controls })).catch(() => {});
  onGlobal((m) => {
    if (m.kind === "plan") shared.set({ plan: m.plan });
    if (m.kind === "controls") shared.set({ controls: m.controls });
    if (m.kind === "running") shared.set((s) => ({ running: { ...s.running, [m.session]: m.running } }));
  });
}

/** Commands that only work as a terminal menu: on the phone they point to a screen instead. */
export const TERMINAL_ONLY: Record<string, string | null> = {
  config: "設定", plugin: "Plugin", plugins: "Plugin", login: null, logout: null, resume: null, exit: null,
  quit: null, vim: null, terminal: null, "terminal-setup": null, ide: null, theme: null, doctor: null, permissions: null,
};
