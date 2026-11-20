import * as React from "react";
import { createPortal } from "react-dom";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { imageUrl, mentionedImages, SessionContext } from "@/lib/session-images";
import { cn } from "@/lib/utils";
import { chipLabel, markFiles, parseRef, resolveFile, type FileInfo } from "@/lib/file-mentions";
import { openPreview } from "@/lib/preview";
import { get } from "@/lib/api";
import { useIsLocalHost } from "@/lib/tauri";
import { useContextItems } from "@/ui/context-menu";
import { Copy, Eye, FolderOpen } from "@phosphor-icons/react/ssr";
import { FileIcon } from "./file-icon";
import { fileUrl, revealInExplorer, type FileData } from "./preview-views";
import { openImage, Thumb } from "./lightbox";

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const MAX_PREVIEWS = 8;

// GFM autolinks only stop at whitespace, so "https://x.com。第一次" swallows the CJK text after it.
// A bare URL never contains CJK or full-width punctuation; cut the link where they begin.
const NOT_URL = /[⺀-鿿가-힯豈-﫿︰-﹏＀-￯　-〿‘-‟…]/;

function trimAutolinks(root: DocumentFragment) {
  for (const a of root.querySelectorAll("a")) {
    const text = a.textContent ?? "";
    let href = a.getAttribute("href") ?? "";
    try { href = decodeURI(href); } catch { continue; }
    if (a.childNodes.length !== 1 || !text || !href.endsWith(text)) continue;
    const cut = text.search(NOT_URL);
    if (cut <= 0) continue;
    const kept = text.slice(0, cut).replace(/[.,;:!?)]+$/, "");
    a.textContent = kept;
    a.setAttribute("href", href.slice(0, href.length - text.length) + kept);
    a.after(text.slice(kept.length));
  }
}

// Points images at where they can load and lists the image paths the text names without showing.
// Paths are rewritten before sanitizing, which would otherwise drop a src like "C:/…" as an
// unknown scheme; a template's content is inert, so nothing in it loads or runs meanwhile.
function render(text: string, session: string | null) {
  const box = document.createElement("template");
  box.innerHTML = marked.parse(text, { async: false, breaks: false, gfm: true }) as string;
  trimAutolinks(box.content);
  const shown = new Set<string>();
  for (const img of box.content.querySelectorAll("img")) {
    const url = imageUrl(session, img.getAttribute("src") ?? "");
    if (!url) { img.replaceWith(img.alt || ""); continue; }
    img.setAttribute("src", url);
    img.setAttribute("loading", "lazy");
    shown.add(url);
  }
  const previews: string[][] = [];
  for (const readings of mentionedImages(text)) {
    const urls = readings.map((p) => imageUrl(session, p)).filter((url): url is string => !!url);
    if (!urls.length || urls.some((url) => shown.has(url))) continue;
    for (const url of urls) shown.add(url);
    previews.push(urls);
    if (previews.length === MAX_PREVIEWS) break;
  }
  if (session) markFiles(box.content);
  return { html: DOMPurify.sanitize(box.innerHTML), previews };
}

/** Claude's text, rendered. It can be selected, unlike the chrome around it. Images in it open large when tapped. */
export function Markdown({ className, text }: { className?: string; text: string }) {
  const session = React.useContext(SessionContext);
  const { html, previews } = React.useMemo(() => render(text, session), [text, session]);
  const body = React.useRef<HTMLDivElement>(null);
  // Written by hand, and only when it changed: React re-applied the same dangerouslySetInnerHTML
  // on unrelated re-renders while a turn ran, which replaced the text and dropped any selection.
  const written = React.useRef<string | null>(null);
  React.useLayoutEffect(() => {
    const el = body.current;
    if (!el || written.current === html) return;
    el.innerHTML = html;
    written.current = html;
  }, [html]);
  React.useEffect(() => {
    const el = body.current;
    if (!el) return;
    // An image that cannot load leaves nothing behind rather than a broken icon.
    const failed = (event: Event) => { if (event.target instanceof HTMLImageElement) event.target.remove(); };
    el.addEventListener("error", failed, true);
    return () => el.removeEventListener("error", failed, true);
  }, []);
  useCopyButtons(body, html);
  const chips = useFileChips(body, session, html);
  const local = useIsLocalHost();
  // Right-clicking a file chip: preview it, copy its path, or show it in File Explorer (desktop app on this computer).
  useContextItems(body, (target) => {
    const chip = target.closest<HTMLElement>("[data-file-kind]");
    const info = chip && found.get(chip);
    if (!session || !chip || !info) return null;
    return [
      { key: "preview", label: "預覽", icon: Eye, onSelect: () => openPreview({ kind: "file", session, path: info.path, line: parseRef(chip.dataset.file ?? "").line }) },
      { key: "copy-path", label: "複製路徑", icon: Copy, onSelect: () => { void navigator.clipboard.writeText(info.path).catch(() => {}); } },
      ...(local ? [{ key: "reveal", label: "在檔案總管顯示", icon: FolderOpen, onSelect: () => {
        void get<FileData>(fileUrl(session, "file", info.path)).then((d) => revealInExplorer(d.hostPath || d.path), () => revealInExplorer(info.path));
      } }] : []),
    ];
  });
  return (
    <div className={cn("grid min-w-0 gap-2", className)}>
      <div
        className="markdown-body min-w-0 text-[0.9375rem] text-ink"
        data-selectable=""
        onClick={(event) => {
          const target = event.target as HTMLElement;
          const copy = target.closest<HTMLButtonElement>(".code-copy");
          if (copy) { event.preventDefault(); void copyCode(copy); return; }
          if (target instanceof HTMLImageElement) { event.preventDefault(); openImage(target.src); return; }
          const chip = target.closest<HTMLElement>("[data-file-kind]");
          const info = chip && found.get(chip);
          if (!session || !chip || !info) return;
          event.preventDefault();
          openPreview({ kind: "file", session, path: info.path, line: parseRef(chip.dataset.file ?? "").line });
        }}
        ref={body}
      />
      {chips.map((c) => createPortal(<FileIcon className="size-[1.05em]" kind={c.info.kind} name={c.info.name} />, c.icon, c.key))}
      {previews.length ? (
        <div className="flex flex-wrap gap-2">{previews.map((urls) => <Thumb key={urls.join("\n")} src={urls} />)}</div>
      ) : null}
    </div>
  );
}

const COPY_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const DONE_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

/** Wraps each code block so a copy button can sit in its top-right corner without scrolling with the code. */
function useCopyButtons(body: React.RefObject<HTMLDivElement | null>, html: string) {
  React.useEffect(() => {
    const el = body.current;
    if (!el) return;
    for (const pre of el.querySelectorAll("pre")) {
      if (pre.parentElement?.classList.contains("code-wrap")) continue;
      const wrap = document.createElement("div");
      wrap.className = "code-wrap";
      pre.replaceWith(wrap);
      wrap.append(pre);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "code-copy";
      button.title = "Copy";
      button.setAttribute("aria-label", "Copy code");
      button.innerHTML = COPY_ICON;
      wrap.append(button);
    }
  }, [body, html]);
}

const resetTimers = new WeakMap<HTMLElement, number>();
async function copyCode(button: HTMLButtonElement) {
  const pre = button.parentElement?.querySelector("pre");
  if (!pre) return;
  try { await navigator.clipboard.writeText(pre.textContent ?? ""); } catch { return; }
  button.innerHTML = DONE_ICON;
  window.clearTimeout(resetTimers.get(button));
  resetTimers.set(button, window.setTimeout(() => { button.innerHTML = COPY_ICON; }, 1500));
}

// The file each chip opens, kept beside the DOM the markdown owns.
const found = new WeakMap<HTMLElement, FileInfo>();
interface Chip { key: string; icon: HTMLElement; info: FileInfo }

/**
 * Turns the paths marked in rendered markdown into chips once the server confirms each exists.
 * Paths that are not there are left as written.
 */
function useFileChips(body: React.RefObject<HTMLDivElement | null>, session: string | null, html: string) {
  const [chips, setChips] = React.useState<Chip[]>([]);
  React.useEffect(() => {
    const el = body.current;
    setChips([]);
    if (!el || !session) return;
    let live = true;
    const nodes = [...el.querySelectorAll<HTMLElement>("[data-file]")];
    void Promise.all(nodes.map(async (node, i) => {
      const info = await resolveFile(session, parseRef(node.dataset.file ?? "").path);
      if (!live || !info || info.kind === "dir" || !node.isConnected) return null;
      found.set(node, info);
      node.dataset.fileKind = info.kind;
      node.title = info.path;
      const label = chipLabel(node.dataset.file ?? "", info);
      if (node.textContent !== label && node.tagName !== "A") node.textContent = label;
      const icon = document.createElement("span");
      icon.className = "file-ref-icon";
      node.prepend(icon);
      return { key: `${i}`, icon, info };
    })).then((list) => { if (live) setChips(list.filter((c): c is Chip => !!c)); });
    return () => { live = false; };
  }, [body, session, html]);
  return chips;
}
