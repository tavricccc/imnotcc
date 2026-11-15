// What the preview panel shows: one file, one file's change in a turn, or a session's
// background work. Opening something else replaces it.
import { createStore } from "./store-core";
import type { FileChange } from "./turns";

export type PreviewTarget =
  | { kind: "file"; session: string; path: string; line?: number }
  /** `files` are the turn's other changed files, for stepping through them one at a time. */
  | { kind: "diff"; session: string; turn: string; path: string; files: FileChange[] }
  | { kind: "tasks"; session: string };

/** One piece of background work, as the server lists it (shells, agents, monitors). */
export interface BackgroundTask {
  id: string; type: string; agent: string | null; description: string;
  command?: string | null; // the shell command, or an agent's prompt
  startedAt?: number;
}
/** Each open session's live background work, kept by its chat for the panel to show. */
export const backgroundTasks = createStore<Record<string, BackgroundTask[]>>({});

export const preview = createStore<{ target: PreviewTarget | null; version: number }>({ target: null, version: 0 });

export const openPreview = (target: PreviewTarget) => preview.set({ target });
export const closePreview = () => preview.set({ target: null });
/** Asks an open file to load again, after a turn may have changed it. */
export const refreshPreview = () => preview.set((v) => ({ version: v.version + 1 }));
