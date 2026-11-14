// Files Claude names in a reply: found in the rendered markdown, checked against the computer in
// batches, and turned into chips that open the preview panel. A path that does not exist stays
// as it was written.
import { post } from "./api";

export type FileKind = "text" | "markdown" | "html" | "image" | "pdf" | "binary" | "dir";
/** A file as the server found it; `path` is absolute, in the session's own notation. */
export interface FileInfo { path: string; name: string; kind: FileKind; size: number; mtime: number }
/** A path as written, split from the line it points at ("a.ts:42", "a.ts#L42"). */
export interface FileRef { path: string; line?: number }

const LINE = /(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/;
const SCHEME = /^[a-z][\w+.-]*:/i;
const DRIVE = /^[A-Za-z]:[\\/]/;

export function parseRef(raw: string): FileRef {
  let s = raw.trim();
  if (/^file:\/\//i.test(s)) s = s.replace(/^file:\/\//i, "").replace(/^\/(?=[A-Za-z]:)/, "");
  if (/%[0-9a-f]{2}/i.test(s)) { try { s = decodeURIComponent(s); } catch { /* keep as written */ } }
  const m = s.match(LINE);
  // "C:" alone is a drive, not a line.
  if (m && !(m[1] && /^[A-Za-z]$/.test(s.slice(0, m.index)))) {
    return { path: s.slice(0, m.index), line: Number(m[1] ?? m[2]) };
  }
  return { path: s };
}

/** Whether a whole string (an inline code span, a link) reads as a file path. */
export function looksLikePath(raw: string): boolean {
  const s = raw.trim();
  if (!s || s.length > 400 || /[\n<>"|?*]/.test(s)) return false;
  if (SCHEME.test(s) && !DRIVE.test(s) && !/^file:\/\//i.test(s)) return false;
  const { path } = parseRef(s);
  // A name with an extension, or a path with a separator in it.
  return /\.[A-Za-z][\w-]{0,9}$/.test(path) || (/[\\/]/.test(path) && !/\s/.test(path) && !/[\\/]$/.test(path));
}

// A path in running prose: no spaces, ends in an extension, optionally a line after it.
const PROSE = /(?<![\w@/\\.:-])((?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|\/)?(?:[\w@+-][\w.+-]*[\\/])*[\w+-][\w.+-]*\.[A-Za-z][\w-]{0,9}(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)?)(?![\w/\\-]|\.[A-Za-z])/g;

/**
 * Marks the paths in rendered markdown with `data-file` (the text as written): whole inline code
 * spans, links to local paths, and paths in plain text, which are wrapped in a span.
 */
export function markFiles(root: DocumentFragment | Element) {
  for (const code of root.querySelectorAll("code")) {
    if (code.closest("pre, a")) continue;
    const text = code.textContent ?? "";
    if (looksLikePath(text)) code.setAttribute("data-file", text.trim());
  }
  for (const a of root.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#") || (SCHEME.test(href) && !DRIVE.test(href) && !/^file:/i.test(href))) continue;
    if (looksLikePath(href)) a.setAttribute("data-file", href);
  }
  const doc = root.ownerDocument ?? document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!(n.parentElement?.closest("pre, code, a"))) nodes.push(n as Text);
  }
  for (const node of nodes) {
    const text = node.data;
    PROSE.lastIndex = 0;
    if (!PROSE.test(text)) continue;
    PROSE.lastIndex = 0;
    const out = doc.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(PROSE)) {
      out.append(text.slice(last, m.index));
      const span = doc.createElement("span");
      span.setAttribute("data-file", m[1]);
      span.textContent = m[1];
      out.append(span);
      last = m.index! + m[0].length;
    }
    out.append(text.slice(last));
    node.replaceWith(out);
  }
}

// ---- Checking paths against the computer, a batch at a time ----

const known = new Map<string, Promise<FileInfo | null>>();
let queue: { session: string; path: string; resolve: (f: FileInfo | null) => void }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  timer = null;
  const batch = queue;
  queue = [];
  const bySession = new Map<string, typeof batch>();
  for (const item of batch) bySession.set(item.session, [...(bySession.get(item.session) ?? []), item]);
  for (const [session, items] of bySession) {
    for (let i = 0; i < items.length; i += 100) {
      const chunk = items.slice(i, i + 100);
      post<{ files: (FileInfo | null)[] }>(`/api/sessions/${encodeURIComponent(session)}/resolve`, { paths: chunk.map((x) => x.path) })
        .then((r) => chunk.forEach((x, j) => x.resolve(r.files[j] ?? null)))
        .catch(() => chunk.forEach((x) => { known.delete(`${session}\n${x.path}`); x.resolve(null); }));
    }
  }
}

/** The file a path points at in a session, or null when there is none. Answers are remembered. */
export function resolveFile(session: string, path: string): Promise<FileInfo | null> {
  const key = `${session}\n${path}`;
  let hit = known.get(key);
  if (!hit) {
    hit = new Promise((resolve) => queue.push({ session, path, resolve }));
    known.set(key, hit);
    if (!timer) timer = setTimeout(flush, 30);
  }
  return hit;
}

/** Forgets what is known about a session's paths, after a turn may have created or removed files. */
export function forgetFiles(session: string) {
  for (const key of known.keys()) if (key.startsWith(`${session}\n`)) known.delete(key);
}

const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\/|~[\\/]|\\\\)/;
/** How a chip reads: an absolute path shortens to its name, a relative one stays as written. */
export function chipLabel(written: string, info: FileInfo) {
  const { line } = parseRef(written);
  return ABSOLUTE.test(parseRef(written).path) ? `${info.name}${line ? `:${line}` : ""}` : written.trim();
}
