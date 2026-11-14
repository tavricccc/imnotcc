// The server's own settings, one copy per tab, shared by every screen that shows them.
import { get } from "./api";
import { useCached } from "./cache";

export interface Settings { permissionMode: string; model?: string | null; effort?: string | null; folder?: string | null; idleMinutes: number }
export type ClaudeEnv = "win" | "wsl";
export interface CompactWindow { env: ClaudeEnv; model: string; window?: number }
export interface CompactWindows { envs: ClaudeEnv[]; windows: CompactWindow[] }
export interface SessionRow { id: string; cwd: string; title?: string; lastModified?: number; running?: boolean; temporary?: boolean }
interface SessionList { groups: { cwd: string; sessions: SessionRow[] }[]; recent?: SessionRow[] }

export const readSessions = () => get<SessionList>("/api/sessions");
export const useSessions = () => useCached("sessions", readSessions);
const readSettings = () => get("/api/settings").then((r) => r.settings as Settings);
const readFolders = () => get("/api/folders").then((r) => r.folders as string[]);
export const readCompactWindows = () => get<CompactWindows>("/api/compact-windows");

/** `enabled` lets a screen open in a sheet wait for the first time it is opened. */
export const useSettings = (enabled = true) => useCached("settings", readSettings, enabled);
export const useFolders = (enabled = true) => useCached("folders", readFolders, enabled);
export const useCompactWindows = (enabled = true) => useCached("compact-windows", readCompactWindows, enabled);
