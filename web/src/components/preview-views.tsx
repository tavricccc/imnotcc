// What the preview panel shows inside: a file's text, rendered markdown, an image, a PDF, or
// details and a download for anything else.
import * as React from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { toast } from "sonner";
import { ArrowSquareOut, DownloadSimple, FolderOpen, Globe } from "@phosphor-icons/react/ssr";
import { get, post } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { looksLikePath, parseRef, type FileKind } from "@/lib/file-mentions";
import { openPreview } from "@/lib/preview";
import { tauriInvoke, useIsLocalHost } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { highlightLines } from "@/lib/highlight";
import type { ThemedToken } from "shiki/core";
import { Button } from "@/ui/button";
import { ProgressBar } from "@/ui/feedback";
import { ErrorState, LoadingList } from "@/ui/page";

export interface FileData { path: string; hostPath?: string; name: string; kind: FileKind; size: number; mtime: number; text?: string; tooLarge?: boolean }

export const fileUrl = (session: string, kind: "file" | "raw", path: string) =>
  `/api/sessions/${encodeURIComponent(session)}/${kind}?path=${encodeURIComponent(path)}`;

/** A file from the server, loaded again whenever `version` moves on. */
export function useFile(session: string | undefined, path: string | undefined, version: number) {
  const [state, setState] = React.useState<{ data?: FileData; error?: string; path?: string }>({});
  React.useEffect(() => {
    if (!session || !path) return;
    let live = true;
    get<FileData>(fileUrl(session, "file", path))
      .then((data) => { if (live) setState({ data, path }); })
      .catch((e) => { if (live) setState({ error: (e as Error).message, path }); });
    return () => { live = false; };
  }, [session, path, version]);
  // A different file shows loading rather than the last one.
  return path && state.path === path ? state : {};
}

export function FileBody({ file: { data, error }, line, session, source }: { file: { data?: FileData; error?: string }; line?: number; session: string; source: boolean }) {
  if (error) return <ErrorState message={error} retryLabel="重試" title="打不開這個檔案" />;
  if (!data) return <LoadingList label="載入中" rows={3} />;
  const raw = fileUrl(session, "raw", data.path);
  if (data.kind === "image") return <img alt={data.name} className="mx-auto max-w-full rounded-tile" src={raw} />;
  if (data.kind === "pdf") return <iframe className="h-full min-h-[70svh] w-full rounded-tile border border-line" src={raw} title={data.name} />;
  if (data.text === undefined) return <FileFacts data={data} raw={raw} />;
  if (data.kind === "markdown" && !source) return <MarkdownFile data={data} session={session} />;
  return <CodeView line={line} name={data.name} text={data.text} />;
}

export async function revealInExplorer(targetPath: string) {
  try {
    await tauriInvoke("reveal_file", { path: targetPath });
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
  }
}

interface DownloadProgress { active: boolean; loaded: number; total: number; url: string }

function downloadLabel(name: string, loaded: number, total: number) {
  if (total > 0) {
    const pct = Math.min(100, Math.round((loaded / total) * 100));
    return `下載中 ${name} · ${pct}%（${formatBytes(loaded)} / ${formatBytes(total)}）`;
  }
  return loaded > 0 ? `下載中 ${name}（${formatBytes(loaded)}）` : `準備下載 ${name}…`;
}

/** Streams a remote file with live byte progress and triggers a browser/WebView save when done. */
function useFileDownload({ name, size, url }: { name: string; size?: number; url: string }) {
  const [state, setState] = React.useState<DownloadProgress>({ active: false, loaded: 0, total: 0, url: "" });
  const mounted = React.useRef(true);
  const busy = React.useRef(false);
  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const start = React.useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const expected = size ?? 0;
    const toastId = toast.loading(`準備下載 ${name}…`);
    if (mounted.current) setState({ active: true, loaded: 0, total: expected, url });
    try {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const body = await res.json() as { error?: string };
          if (body?.error) msg = body.error;
        } catch { /* non-JSON error body */ }
        throw new Error(msg);
      }
      const total = Number(res.headers.get("Content-Length")) || expected;
      const mime = res.headers.get("Content-Type") || "application/octet-stream";
      let blob: Blob;
      if (res.body) {
        const reader = res.body.getReader();
        const chunks: BlobPart[] = [];
        let loaded = 0;
        let lastTick = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            loaded += value.byteLength;
            const now = Date.now();
            if (now - lastTick >= 80) {
              lastTick = now;
              toast.loading(downloadLabel(name, loaded, total), { id: toastId });
              if (mounted.current) setState({ active: true, loaded, total, url });
            }
          }
        }
        toast.loading(downloadLabel(name, loaded, total || loaded), { id: toastId });
        if (mounted.current) setState({ active: true, loaded, total: total || loaded, url });
        blob = new Blob(chunks, { type: mime });
      } else {
        blob = await res.blob();
      }
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = name;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
      toast.success(`已下載 ${name}`, { id: toastId });
    } catch (e) {
      toast.error(`下載失敗：${e instanceof Error ? e.message : String(e)}`, { id: toastId });
    } finally {
      busy.current = false;
      if (mounted.current) setState({ active: false, loaded: 0, total: 0, url: "" });
    }
  }, [name, size, url]);

  const active = state.active && state.url === url;
  const pct = active && state.total > 0 ? Math.min(100, Math.round((state.loaded / state.total) * 100)) : null;
  return { active, loaded: state.loaded, total: state.total, pct, start };
}

function FileFacts({ data, raw }: { data: FileData; raw: string }) {
  const isHost = useIsLocalHost();
  const dl = useFileDownload({ name: data.name, size: data.size, url: raw });
  return (
    <div className="grid justify-items-start gap-3 py-6 text-sm text-ink-muted">
      <p>{data.tooLarge ? "檔案太大，不在這裡顯示。" : "這個檔案不是文字，沒辦法預覽。"}</p>
      <p>{formatBytes(data.size)} · {new Date(data.mtime).toLocaleString()}</p>
      {isHost ? (
        <Button onClick={() => void revealInExplorer(data.hostPath || data.path)} size="sm">
          <FolderOpen />在檔案總管顯示
        </Button>
      ) : (
        <div className="grid w-full max-w-xs justify-items-start gap-2">
          <Button onClick={() => void dl.start()} size="sm" status={dl.active ? "loading" : "idle"}>
            {dl.active ? null : <DownloadSimple />}
            {dl.active ? (dl.pct !== null ? `下載中 ${dl.pct}%` : "下載中…") : "下載"}
          </Button>
          {dl.active ? (
            <div className="grid w-full gap-1">
              {dl.total > 0 ? <ProgressBar label={`下載 ${data.name}`} value={dl.loaded / dl.total} /> : null}
              <span className="text-xs tabular-nums text-ink-muted">
                {dl.total > 0 ? `${formatBytes(dl.loaded)} / ${formatBytes(dl.total)} · ${dl.pct}%` : formatBytes(dl.loaded)}
              </span>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Plain text with line numbers; `line` is scrolled to and marked. */
export function CodeView({ line, name, text }: { line?: number; name: string; text: string }) {
  const clean = React.useMemo(() => text.replace(/\r\n/g, "\n").replace(/\n$/, ""), [text]);
  const lines = React.useMemo(() => clean.split("\n"), [clean]);
  const tokens = useTokens(clean, name);
  const target = React.useRef<HTMLSpanElement>(null);
  React.useEffect(() => { target.current?.scrollIntoView({ block: "center" }); }, [line, text]);
  return (
    <div className="code-tokens overflow-x-auto rounded-tile bg-surface-raised py-3 font-mono text-[0.8125rem] leading-[1.6]" data-selectable="">
      <div className="grid min-w-max grid-cols-[auto_1fr]">
        {lines.map((l, i) => (
          <div className={cn("contents", line === i + 1 && "[&>*]:bg-accent-soft")} key={i}>
            <span className="select-none px-3 text-right text-ink-faint" ref={line === i + 1 ? target : undefined}>{i + 1}</span>
            <span className="whitespace-pre pr-4">{tokens?.[i] ? <Tokens line={tokens[i]} /> : l || " "}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const dirOf = (p: string) => p.slice(0, Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);
const isRelative = (p: string) => !/^(?:[A-Za-z]:[\\/]|\/|~[\\/]|\\\\|[a-z][\w+.-]*:|#)/i.test(p);

/** A markdown file, rendered; its relative images and links are read from the file's own folder. */
function MarkdownFile({ data, session }: { data: FileData; session: string }) {
  const dir = dirOf(data.path);
  const join = React.useCallback((p: string) => (isRelative(p) ? dir + p.replace(/^\.[\\/]/, "") : p), [dir]);
  const html = React.useMemo(() => {
    const box = document.createElement("template");
    box.innerHTML = marked.parse(data.text ?? "", { async: false, gfm: true }) as string;
    for (const img of box.content.querySelectorAll("img")) {
      const src = img.getAttribute("src") ?? "";
      if (!/^(https?:|data:)/i.test(src)) img.setAttribute("src", fileUrl(session, "raw", join(parseRef(src).path)));
    }
    for (const a of box.content.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href") ?? "";
      if (isRelative(href) && looksLikePath(href)) a.setAttribute("data-file", href);
    }
    return DOMPurify.sanitize(box.innerHTML);
  }, [data.text, session, join]);
  return (
    <div
      className="markdown-body min-w-0 text-[0.9375rem] text-ink"
      dangerouslySetInnerHTML={{ __html: html }}
      data-selectable=""
      onClick={(event) => {
        const a = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[data-file]");
        if (!a) return;
        event.preventDefault();
        const ref = parseRef(a.dataset.file ?? "");
        openPreview({ kind: "file", session, path: join(ref.path), line: ref.line });
      }}
    />
  );
}

/** On Host, reveals the file in File Explorer; on Remote, opens images/PDFs or downloads with progress. */
export function OpenRaw({ hostPath, kind, name, path, session, size }: { hostPath?: string; kind: FileKind; name: string; path: string; session: string; size?: number }) {
  const isHost = useIsLocalHost();
  const raw = fileUrl(session, "raw", path);
  const dl = useFileDownload({ name, size, url: raw });
  const inline = kind === "image" || kind === "pdf";

  if (isHost) {
    const label = "在檔案總管顯示";
    return (
      <Button aria-label={label} onClick={() => void revealInExplorer(hostPath || path)} size="icon-sm" title={label} variant="ghost">
        <FolderOpen />
      </Button>
    );
  }

  if (inline) {
    return (
      <Button asChild aria-label="在新分頁開啟" size="icon-sm" title="在新分頁開啟" variant="ghost">
        <a href={raw} rel="noopener noreferrer" target="_blank"><ArrowSquareOut /></a>
      </Button>
    );
  }

  const label = dl.active ? (dl.pct !== null ? `下載中 ${dl.pct}%` : "下載中…") : "下載";
  return (
    <Button aria-label={label} onClick={() => void dl.start()} size="icon-sm" status={dl.active ? "loading" : "idle"} title={label} variant="ghost">
      {dl.active ? null : <DownloadSimple />}
    </Button>
  );
}

/** Coloured lines for a file's text, once the highlighter has them; null meanwhile or for unknown languages. */
export function useTokens(text: string, name: string) {
  const [state, setState] = React.useState<{ key: string; tokens: ThemedToken[][] | null } | null>(null);
  const key = `${name}\n${text}`;
  React.useEffect(() => {
    let live = true;
    highlightLines(text, name).then((tokens) => { if (live) setState({ key, tokens }); }).catch(() => {});
    return () => { live = false; };
  }, [key, text, name]);
  return state?.key === key ? state.tokens : null;
}

export function Tokens({ line }: { line: ThemedToken[] }) {
  return <>{line.map((t, i) => <span key={i} style={t.htmlStyle as React.CSSProperties}>{t.content}</span>)}</>;
}

/**
 * Opens a local HTML page in a new tab, sandboxed by the server. The tab is opened before the
 * link is asked for, so the browser counts it as the tap's own and does not block it.
 */
export function OpenPage({ path, session }: { path: string; session: string }) {
  const [busy, setBusy] = React.useState(false);
  async function open() {
    const tab = window.open("", "_blank");
    setBusy(true);
    try {
      const { url } = await post<{ url: string }>(`/api/sessions/${encodeURIComponent(session)}/preview-link`, { path });
      if (tab) { tab.opener = null; tab.location.href = url; } else window.location.assign(url);
    } catch (e) {
      tab?.close();
      toast.error((e as Error).message);
    } finally { setBusy(false); }
  }
  return (
    <Button onClick={() => void open()} size="sm" status={busy ? "loading" : "idle"} variant="secondary">
      <Globe />在新分頁開啟
    </Button>
  );
}
