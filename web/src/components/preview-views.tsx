// What the preview panel shows inside: a file's text, rendered markdown, an image, a PDF, or
// details and a download for anything else.
import * as React from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { ArrowSquareOut, DownloadSimple } from "@phosphor-icons/react/ssr";
import { get } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { looksLikePath, parseRef, type FileKind } from "@/lib/file-mentions";
import { openPreview } from "@/lib/preview";
import { cn } from "@/lib/utils";
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
export function CodeView({ line, text }: { line?: number; name: string; text: string }) {
  const lines = React.useMemo(() => text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"), [text]);
  const target = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => { target.current?.scrollIntoView({ block: "center" }); }, [line, text]);
  return (
    <div className="overflow-x-auto rounded-tile bg-surface-raised py-3 font-mono text-[0.8125rem] leading-[1.6]" data-selectable="">
      <div className="grid min-w-max grid-cols-[auto_1fr]">
        {lines.map((l, i) => (
          <div className={cn("contents", line === i + 1 && "[&>*]:bg-accent-soft")} key={i} ref={line === i + 1 ? target : undefined}>
            <span className="select-none px-3 text-right text-ink-faint">{i + 1}</span>
            <span className="whitespace-pre pr-4">{l || " "}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const SEP = /[\\/]/;
const dirOf = (p: string) => p.slice(0, Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);
const isRelative = (p: string) => !/^(?:[A-Za-z]:[\\/]|\/|~[\\/]|\\\\|[a-z][\w+.-]*:|#)/i.test(p);

/** A markdown file, rendered; its relative images and links are read from the file's own folder. */
function MarkdownFile({ data, session }: { data: FileData; session: string }) {
  const dir = dirOf(data.path);
  const join = React.useCallback((p: string) => (isRelative(p) ? dir + p.replace(/^\.[\\/]/, "").replace(SEP, dir.includes("\\") ? "\\" : "/") : p), [dir]);
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

/** Opens the raw file in a new tab: for a PDF on a phone, or anything to save. */
export function OpenRaw({ path, session }: { path: string; session: string }) {
  return (
    <Button asChild aria-label="在新分頁開啟" size="icon-sm" variant="ghost">
      <a href={fileUrl(session, "raw", path)} rel="noopener noreferrer" target="_blank"><ArrowSquareOut /></a>
    </Button>
  );
}
