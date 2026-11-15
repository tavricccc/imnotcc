// Links to other sites: in the desktop app they open in the system browser (the app's own window
// stays on the app); in a browser or the PWA, in a new tab.
import { toast } from "sonner";
import { isTauri, tauriInvoke } from "./tauri";

/** The link's address when it leads off this app to an http(s) site, else null. */
export function externalHref(el: Element | null): string | null {
  const a = el?.closest<HTMLAnchorElement>("a[href]");
  if (!a) return null;
  let url: URL;
  try { url = new URL(a.getAttribute("href")!, location.href); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.origin === location.origin ? null : url.href;
}

export function openLink(url: string) {
  if (isTauri()) void tauriInvoke("open_link", { url }).catch((e) => toast.error(e instanceof Error ? e.message : String(e)));
  else window.open(url, "_blank", "noopener,noreferrer");
}

export const OPEN_LINK_LABEL = () => (isTauri() ? "用系統瀏覽器開啟" : "在新分頁開啟");

/** In the desktop app, a click on a link to another site goes to the system browser. */
export function interceptLinks() {
  if (!isTauri()) return () => {};
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || !(e.target instanceof Element)) return;
    const url = externalHref(e.target);
    if (!url) return;
    e.preventDefault();
    openLink(url);
  };
  document.addEventListener("click", onClick);
  return () => document.removeEventListener("click", onClick);
}
