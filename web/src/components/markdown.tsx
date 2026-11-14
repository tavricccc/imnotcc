import * as React from "react";
import { createPortal } from "react-dom";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { imageUrl, mentionedImages, SessionContext } from "@/lib/session-images";
import { cn } from "@/lib/utils";
import { chipLabel, markFiles, parseRef, resolveFile, type FileInfo } from "@/lib/file-mentions";
import { openPreview } from "@/lib/preview";
import { FileIcon } from "./file-icon";
import { openImage, Thumb } from "./lightbox";

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const MAX_PREVIEWS = 8;

// Points images at where they can load and lists the image paths the text names without showing.
// Paths are rewritten before sanitizing, which would otherwise drop a src like "C:/…" as an
// unknown scheme; a template's content is inert, so nothing in it loads or runs meanwhile.
function render(text: string, session: string | null) {
  const box = document.createElement("template");
  box.innerHTML = marked.parse(text, { async: false, breaks: false, gfm: true }) as string;
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
  React.useEffect(() => {
    const el = body.current;
    if (!el) return;
    // An image that cannot load leaves nothing behind rather than a broken icon.
    const failed = (event: Event) => { if (event.target instanceof HTMLImageElement) event.target.remove(); };
    el.addEventListener("error", failed, true);
    return () => el.removeEventListener("error", failed, true);
  }, []);
  const chips = useFileChips(body, session, html);
  return (
    <div className={cn("grid min-w-0 gap-2", className)}>
      <div
        className="markdown-body min-w-0 text-[0.9375rem] text-ink"
        dangerouslySetInnerHTML={{ __html: html }}
        data-selectable=""
        onClick={(event) => {
          const target = event.target as HTMLElement;
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
