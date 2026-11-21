// Display preferences kept per device: a phone and a computer can differ.
import { createStore } from "./store-core";

export const SESSION_LIMITS = ["all", "5", "10", "20", "50", "100"] as const;
type SessionLimit = typeof SESSION_LIMITS[number];

export interface Prefs { groupTools: boolean; bubbles: boolean; hideWork: boolean; sessionEnvironment: "win" | "wsl"; sessionSidebarCollapsed: boolean; sessionSidebarWidth: number; projectSessionLimit: SessionLimit; previewWidth: number; inspectorWidth: number; busySend: BusySend; reduceMotion: boolean; inspector: boolean }
/** What sending does while Claude is working: hold it for the next turn, or slip it into this one. */
export type BusySend = "queue" | "steer";
export const BUSY_SEND_LABEL: Record<BusySend, string> = { queue: "加入佇列", steer: "引導" };
const KEY = "imnotcc:prefs";
// Saved under the old name before the rename to imnotcc: carried over once.
try { const old = localStorage.getItem("cc-remote:prefs"); if (old !== null) { if (localStorage.getItem(KEY) === null) localStorage.setItem(KEY, old); localStorage.removeItem("cc-remote:prefs"); } } catch { /* storage blocked */ }
const DEFAULTS: Prefs = { groupTools: true, bubbles: false, hideWork: false, sessionEnvironment: "win", sessionSidebarCollapsed: false, sessionSidebarWidth: 272, projectSessionLimit: "all", previewWidth: 560, inspectorWidth: 320, busySend: "queue", reduceMotion: false, inspector: true };

function load(): Prefs {
  try {
    const saved = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
    if (!SESSION_LIMITS.includes(saved.projectSessionLimit)) saved.projectSessionLimit = DEFAULTS.projectSessionLimit;
    if (saved.busySend !== "queue" && saved.busySend !== "steer") saved.busySend = DEFAULTS.busySend;
    return saved;
  } catch { return DEFAULTS; }
}

export const prefs = createStore<Prefs>(load());
prefs.subscribe(() => { try { localStorage.setItem(KEY, JSON.stringify(prefs.get())); } catch { /* private mode */ } });

// Reduced motion is a manual choice, off by default; the OS setting is not consulted.
const syncMotion = () => document.documentElement.toggleAttribute("data-reduce-motion", prefs.get().reduceMotion);
syncMotion();
prefs.subscribe(syncMotion);
export const reduceMotion = () => prefs.get().reduceMotion;
