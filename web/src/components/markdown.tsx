import * as React from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { imageUrl, mentionedImages, SessionContext } from "@/lib/session-images";
import { cn } from "@/lib/utils";
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
  return (
    <div className={cn("grid min-w-0 gap-2", className)}>
      <div
        className="markdown-body min-w-0 text-[0.9375rem] text-ink"
        dangerouslySetInnerHTML={{ __html: html }}
        data-selectable=""
        onClick={(event) => {
          const target = event.target as HTMLElement;
          if (target instanceof HTMLImageElement) { event.preventDefault(); openImage(target.src); }
        }}
        ref={body}
      />
      {previews.length ? (
        <div className="flex flex-wrap gap-2">{previews.map((urls) => <Thumb key={urls.join("\n")} src={urls} />)}</div>
      ) : null}
    </div>
  );
}
