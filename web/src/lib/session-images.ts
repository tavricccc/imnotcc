import * as React from "react";

/** The session whose folder relative image paths are read from; null outside a chat. */
export const SessionContext = React.createContext<string | null>(null);

const IMAGE_PATH = /\.(png|jpe?g|gif|webp)$/i;
const REMOTE = /^(https?:|data:|blob:)/i;

/** Where the browser can load an image Claude wrote: web and data URLs as they are, file paths through the server. */
export function imageUrl(session: string | null, src: string): string | null {
  const s = src.trim();
  if (REMOTE.test(s)) return s;
  if (!session || !IMAGE_PATH.test(s)) return null;
  let path = s;
  if (/^file:/i.test(path)) path = path.replace(/^file:\/\//i, "").replace(/^\/(?=[A-Za-z]:)/, "");
  if (/%[0-9a-f]{2}/i.test(path)) { try { path = decodeURIComponent(path); } catch { /* keep as written */ } }
  return `/api/sessions/${encodeURIComponent(session)}/image?path=${encodeURIComponent(path)}`;
}

// A whole inline code span that is an image path, which may have spaces in it.
const CODE_PATH = /`([^`\n]+\.(?:png|jpe?g|gif|webp))`/gi;
// Where an image file name ends in prose.
const IMAGE_END = /\.(?:png|jpe?g|gif|webp)(?![\w/\\])/gi;
// What a path written in prose does not run through: quotes, brackets, emphasis and CJK punctuation.
const NOT_PATH = /[`"'<>|*?，。；：、！？「」『』（）()[\]{}]/;
// Where a path plainly starts: C:\, \\server, ~/, ./, ../ or /.
const ANCHOR = /(?:^|\s)([A-Za-z]:[\\/]|\\\\|~[\\/]|\.{1,2}[\\/]|\/)/g;
// How many space-separated words a relative path may reach back over.
const MAX_WORDS = 3;

const isDriveColon = (line: string, i: number) =>
  /[A-Za-z]/.test(line[i - 1] ?? "") && !/\w/.test(line[i - 2] ?? "") && /[\\/]/.test(line[i + 1] ?? "");

// The paths a name ending at `end` could be, longest first: with spaces, a path can only be
// told apart from the prose before it by trying, so the caller shows the first that loads.
function candidates(line: string, end: number, extLength: number): string[] | null {
  let start = end - extLength;
  while (start > 0 && !NOT_PATH.test(line[start - 1]) && (line[start - 1] !== ":" || isDriveColon(line, start - 1))) start--;
  // Part of a URL, which the markdown already shows or links.
  if (/[a-z][\w+.-]*:$/i.test(line.slice(0, start))) return null;
  const region = line.slice(start, end);
  const tail = region.slice(region.search(/\S+$/));
  if (/^\.\w+$/.test(tail)) return null;
  const out: string[] = [];
  // The nearest start, so a second path on the line does not reach back into the first.
  const anchor = [...region.matchAll(ANCHOR)].at(-1);
  if (anchor) out.push(region.slice(anchor.index! + anchor[0].length - anchor[1].length));
  else {
    const starts = [0, ...[...region.matchAll(/\s+/g)].map((s) => s.index! + s[0].length)].filter((i) => i < region.length);
    for (const i of starts.slice(-(MAX_WORDS + 1))) out.push(region.slice(i));
  }
  out.push(tail);
  return [...new Set(out.map((p) => p.trim()).filter(Boolean))];
}

/** Image paths mentioned in the text, in order; each is a list of readings to try, longest first. */
export function mentionedImages(text: string): string[][] {
  const out = new Map<string, string[]>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(CODE_PATH, (_, path: string) => {
      const p = path.trim();
      if (!/^[a-z][\w+.-]*:\/\//i.test(p)) out.set(p, [p]);
      return " ";
    });
    for (const m of line.matchAll(IMAGE_END)) {
      const found = candidates(line, m.index! + m[0].length, m[0].length);
      if (found) out.set(found.join("\n"), found);
    }
  }
  return [...out.values()];
}
