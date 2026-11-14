// What the preview panel shows inside: a file's text, rendered markdown, an image, a PDF, or
// details and a download for anything else.
import * as React from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { toast } from "sonner";
import { ArrowSquareOut, DownloadSimple, Globe } from "@phosphor-icons/react/ssr";
import { get, post } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { looksLikePath, parseRef, type FileKind } from "@/lib/file-mentions";
import { openPreview } from "@/lib/preview";
import { cn } from "@/lib/utils";
import { highlightLines } from "@/lib/highlight";
import type { ThemedToken } from "shiki/core";
import { Button } from "@/ui/button";
import { ErrorState, LoadingList } from "@/ui/page";

export interface FileData { path: string; name: string; kind: FileKind; size: number; mtime: number; text?: string; tooLarge?: boolean }

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

function FileFacts({ data, raw }: { data: FileData; raw: string }) {
  return (
    <div className="grid justify-items-start gap-3 py-6 text-sm text-ink-muted">
      <p>{data.tooLarge ? "檔案太大，不在這裡顯示。" : "這個檔案不是文字，沒辦法預覽。"}</p>
      <p>{formatBytes(data.size)} · {new Date(data.mtime).toLocaleString()}</p>
      <Button asChild size="sm"><a download={data.name} href={raw}><DownloadSimple />下載</a></Button>
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

/** Images and PDFs open in a new tab (a PDF reads better there on a phone); anything else downloads. */
export function OpenRaw({ kind, name, path, session }: { kind: FileKind; name: string; path: string; session: string }) {
  const inline = kind === "image" || kind === "pdf";
  const label = inline ? "在新分頁開啟" : "下載";
  return (
    <Button asChild aria-label={label} size="icon-sm" title={label} variant="ghost">
      {inline
        ? <a href={fileUrl(session, "raw", path)} rel="noopener noreferrer" target="_blank"><ArrowSquareOut /></a>
        : <a download={name} href={fileUrl(session, "raw", path)}><DownloadSimple /></a>}
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
