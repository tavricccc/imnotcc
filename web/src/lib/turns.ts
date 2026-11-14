import type { Item } from "./transcript";

export type TurnRow =
  | { kind: "item"; item: Item }
  | { kind: "work"; key: string; items: Item[]; start?: number; end?: number; live: boolean }
  | { kind: "files"; key: string; turn: string; files: FileChange[] }
  | { kind: "copy"; key: string; text: string };

/** A file a turn changed, as git counted it; binary files have no line counts. */
export interface FileChange { path: string; added: number | null; removed: number | null }

export const isStep = (it: Item) => it.type === "tool" || it.type === "thinking";

/** Split the transcript into turns: each answer stays out, the work before it folds. */
export function turnRows(items: Item[], running: boolean, changes: Record<string, FileChange[]> = {}): TurnRow[] {
  const out: TurnRow[] = [];
  let i = 0;
  while (i < items.length) {
    // The user's message (an image and its text arrive as separate items).
    let start: number | undefined;
    let prompt: string | undefined;
    while (i < items.length && items[i].type === "user") { start = items[i].at ?? start; prompt ??= items[i].uuid; out.push({ kind: "item", item: items[i++] }); }
    let j = i;
    while (j < items.length && items[j].type !== "user") j++;
    const segment = items.slice(i, j);
    const last = segment.findLastIndex(isStep);
    // The answer the turn ended with, copyable once the turn is over.
    const answer = segment.slice(last + 1).filter((it) => it.type === "assistant" && it.text?.trim()).map((it) => it.text!.trim()).join("\n\n");
    const over = !(running && j === items.length);
    if (last < 0) {
      for (const item of segment) out.push({ kind: "item", item });
    } else {
      const live = running && j === items.length;
      const times = segment.flatMap((it) => [it.at, it.endAt]).filter((t): t is number => !!t);
      out.push({ kind: "work", key: `work-${segment[0].key}`, items: segment.slice(0, last + 1), start, end: times.length ? Math.max(...times) : undefined, live });
      for (const item of segment.slice(last + 1)) out.push({ kind: "item", item });
      const files = prompt ? changes[prompt] : undefined;
      if (prompt && files?.length && !live) out.push({ kind: "files", key: `files-${segment[0].key}`, turn: prompt, files });
    }
    if (answer && over) out.push({ kind: "copy", key: `copy-${segment[0].key}`, text: answer });
    i = j;
  }
  return out;
}

export const pathOf = (tool: Item): string => tool.input?.file_path ?? tool.input?.notebook_path ?? "";
export const baseName = (path: string) => path.split(/[\/]/).pop() || path;
