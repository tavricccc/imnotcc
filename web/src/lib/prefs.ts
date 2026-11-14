// Display preferences kept per device: a phone and a computer can differ.
import { createStore } from "./store-core";

export const SESSION_LIMITS = ["all", "5", "10", "20", "50", "100"] as const;
type SessionLimit = typeof SESSION_LIMITS[number];

export interface Prefs { groupTools: boolean; bubbles: boolean; hideWork: boolean; sessionEnvironment: "win" | "wsl"; sessionSidebarCollapsed: boolean; sessionSidebarWidth: number; projectSessionLimit: SessionLimit; previewWidth: number }
const KEY = "cc-remote:prefs";
const DEFAULTS: Prefs = { groupTools: true, bubbles: false, hideWork: false, sessionEnvironment: "win", sessionSidebarCollapsed: false, sessionSidebarWidth: 272, projectSessionLimit: "all", previewWidth: 560 };

function load(): Prefs {
  try {
    const saved = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
    if (!SESSION_LIMITS.includes(saved.projectSessionLimit)) saved.projectSessionLimit = DEFAULTS.projectSessionLimit;
    return saved;
  } catch { return DEFAULTS; }
}

export const prefs = createStore<Prefs>(load());
prefs.subscribe(() => { try { localStorage.setItem(KEY, JSON.stringify(prefs.get())); } catch { /* private mode */ } });
