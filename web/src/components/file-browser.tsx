// The file browser in the preview panel: a folder's entries, a step up, and a search over the
// folder by file name or text. A file opens in the same panel, with a way back to where it was.
import * as React from "react";
import { ArrowLeft, ArrowUp, FolderOpen, FolderSimple, MagnifyingGlass, X } from "@phosphor-icons/react/ssr";
import { get } from "@/lib/api";
import { ago, baseName, formatBytes } from "@/lib/format";
import { openPreview, type BrowseState } from "@/lib/preview";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Input } from "@/ui/field";
import { Segmented } from "@/ui/segmented";
import { ErrorState, LoadingList } from "@/ui/page";
import { FileIcon } from "./file-icon";
import { FolderDownload } from "./preview-views";

interface Entry { name: string; path: string; kind: "dir" | "file"; size: number | null; mtime: number | null; link?: boolean }
interface Tree { path: string; parent: string | null; root: string; entries: Entry[]; truncated: boolean }
interface Hit { path: string; line?: number; text?: string }
interface Found { path: string; results: Hit[]; truncated: boolean; engine: string }

const q = (session: string, what: string, params: Record<string, string | undefined>) =>
  `/api/sessions/${encodeURIComponent(session)}/${what}?${new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1]))}`;

/** GETs `url` (none when null), forgetting the last answer while a new one loads. */
function useGet<T>(url: string | null) {
  const [nonce, setNonce] = React.useState(0);
  const [state, setState] = React.useState<{ url?: string; nonce?: number; data?: T; error?: string }>({});
  React.useEffect(() => {
    if (!url) return;
    let live = true;
    get<T>(url).then((data) => { if (live) setState({ url, nonce, data }); }).catch((e) => { if (live) setState({ url, nonce, error: (e as Error).message }); });
    return () => { live = false; };
  }, [url, nonce]);
  const reload = React.useCallback(() => setNonce((n) => n + 1), []);
  const hit = url && state.url === url && state.nonce === nonce ? state : {};
  return { ...hit, reload };
}

export function FilesTitle({ path, session }: { path?: string; session: string }) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <FolderOpen className="mt-0.5 size-5 shrink-0 text-ink-muted" />
      <div className="grid min-w-0 flex-1">
        <span className="truncate text-[0.9375rem] font-semibold">{path ? baseName(path) : "檔案"}</span>
        <span className="truncate text-[0.8125rem] font-normal text-ink-muted" data-selectable="" title={path}>{path ?? "工作資料夾"}</span>
      </div>
      {path ? <FolderDownload path={path} session={session} /> : null}
    </div>
  );
}

/** A file opened from the browser: a step back to the folder or search it came from. */
export function BackToFiles({ from, session }: { from: BrowseState; session: string }) {
  return (
    <Button aria-label="回到檔案" onClick={() => openPreview({ kind: "files", session, ...from })} size="icon-sm" title="回到檔案" variant="ghost">
      <ArrowLeft weight="bold" />
    </Button>
  );
}

export function FilesBody({ mode = "name", path, query, session }: BrowseState & { session: string }) {
  const tree = useGet<Tree>(q(session, "tree", { path }));
  const here = tree.data?.path ?? path;
  const [text, setText] = React.useState(query ?? "");
  const go = (next: BrowseState) => openPreview({ kind: "files", session, ...next });
  const search = (e?: React.FormEvent) => {
    e?.preventDefault();
    const t = text.trim();
    go({ path: here, query: t || undefined, mode });
  };
  const back = { path: here, query, mode };

  return (
    <div className="grid gap-3">
      <form className="grid gap-2" onSubmit={search} role="search">
        <div className="relative">
          <MagnifyingGlass aria-hidden className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-ink-faint" />
          <Input aria-label="搜尋這個資料夾" className="h-10 pr-10 pl-10 text-[0.9375rem]" enterKeyHint="search" onChange={(e) => setText(e.target.value)} placeholder={mode === "name" ? "搜尋檔名" : "搜尋檔案內容"} type="search" value={text} />
          {query ? (
            <button aria-label="清除搜尋" className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-1.5 text-ink-muted hover:bg-surface-hover hover:text-ink" onClick={() => { setText(""); go({ path: here }); }} type="button"><X size={14} weight="bold" /></button>
          ) : null}
        </div>
        <Segmented label="搜尋範圍" onChange={(m) => { if (text.trim()) go({ path: here, query: text.trim(), mode: m }); else go({ path: here, mode: m }); }}
          options={[{ label: "檔名", value: "name" }, { label: "內容", value: "content" }]} value={mode} />
      </form>
      {query ? <Results back={back} mode={mode} path={here} query={query} session={session} />
        : tree.error ? <ErrorState message={tree.error} onRetry={tree.reload} retryLabel="重試" title="打不開這個資料夾" />
        : !tree.data ? <LoadingList label="載入中" rows={4} />
        : <Entries back={back} go={go} session={session} tree={tree.data} />}
    </div>
  );
}

const rowClass = "flex min-h-11 w-full min-w-0 items-center gap-3 rounded-tile px-2 py-1.5 text-left outline-none transition-colors duration-[var(--motion-control)] hover:bg-surface-raised active:bg-surface-pressed focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]";

function Entries({ back, go, session, tree }: { back: BrowseState; go: (s: BrowseState) => void; session: string; tree: Tree }) {
  const atRoot = tree.path === tree.root;
  return (
    <ul className="content-in -mx-2 grid gap-0.5" key={tree.path}>
      {tree.parent ? (
        <li><button className={rowClass} onClick={() => go({ path: tree.parent! })} type="button">
          <ArrowUp className="size-5 shrink-0 text-ink-muted" /><span className="text-[0.9375rem] text-ink-muted">上一層</span>
        </button></li>
      ) : null}
      {!atRoot ? (
        <li><button className={rowClass} onClick={() => go({ path: tree.root })} type="button">
          <FolderSimple className="size-5 shrink-0 text-ink-muted" /><span className="min-w-0 truncate text-[0.9375rem] text-ink-muted">回到工作資料夾</span>
        </button></li>
      ) : null}
      {tree.entries.map((e) => (
        <li key={e.name}>
          <button className={rowClass} onClick={() => (e.kind === "dir" ? go({ path: e.path }) : openPreview({ kind: "file", session, path: e.path, from: back }))} type="button">
            {e.kind === "dir" ? <FolderSimple className="size-5 shrink-0 text-accent-ink" weight="fill" /> : <FileIcon className="size-5 shrink-0 text-ink-muted" kind={guessKind(e.name)} name={e.name} />}
            <span className={cn("min-w-0 flex-1 truncate text-[0.9375rem]", e.name.startsWith(".") && "text-ink-muted")}>{e.name}</span>
            <span className="shrink-0 text-[0.75rem] text-ink-faint tabular-nums">
              {e.kind === "file" && e.size != null ? formatBytes(e.size) : null}
              {e.mtime ? <span className="ml-2 hidden sm:inline">{ago(e.mtime)}</span> : null}
            </span>
          </button>
        </li>
      ))}
      {!tree.entries.length ? <li className="py-8 text-center text-[0.875rem] text-ink-muted">這個資料夾是空的</li> : null}
      {tree.truncated ? <li className="py-3 text-center text-[0.8125rem] text-ink-muted">項目太多，只列出前 5000 個</li> : null}
    </ul>
  );
}

function Results({ back, mode, path, query, session }: { back: BrowseState; mode: "name" | "content"; path?: string; query: string; session: string }) {
  const found = useGet<Found>(q(session, "search", { path, q: query, mode }));
  if (found.error) return <ErrorState message={found.error} onRetry={found.reload} retryLabel="重試" title="搜尋失敗" />;
  if (!found.data) return <LoadingList label="載入中" rows={4} />;
  const { results, truncated, path: root } = found.data;
  if (!results.length) return <p className="py-8 text-center text-[0.875rem] text-ink-muted">找不到「{query}」</p>;
  const rel = (p: string) => (p.startsWith(root) ? p.slice(root.length).replace(/^[\\/]/, "") : p);
  return (
    <ul className="content-in -mx-2 grid gap-0.5" key={`${mode}:${query}`}>
      {results.map((h, i) => (
        <li key={`${h.path}:${h.line ?? ""}:${i}`}>
          <button className={cn(rowClass, "items-start")} onClick={() => openPreview({ kind: "file", session, path: h.path, line: h.line, from: back })} type="button">
            <FileIcon className="mt-0.5 size-5 shrink-0 text-ink-muted" kind={guessKind(h.path)} name={baseName(h.path)} />
            <span className="grid min-w-0 flex-1">
              <span className="truncate text-[0.9375rem]">{baseName(h.path)}{h.line ? <span className="text-ink-faint">:{h.line}</span> : null}</span>
              {h.text != null ? <span className="truncate font-mono text-[0.8125rem] text-ink-muted">{h.text.trim()}</span>
                : <span className="truncate text-[0.75rem] text-ink-faint">{rel(h.path)}</span>}
            </span>
          </button>
        </li>
      ))}
      {truncated ? <li className="py-3 text-center text-[0.8125rem] text-ink-muted">結果太多，只列出前 200 筆</li> : null}
    </ul>
  );
}

const IMG = /\.(png|jpe?g|gif|webp|svg)$/i;
function guessKind(name: string) {
  if (IMG.test(name)) return "image" as const;
  if (/\.pdf$/i.test(name)) return "pdf" as const;
  if (/\.(md|markdown|mdx)$/i.test(name)) return "markdown" as const;
  if (/\.html?$/i.test(name)) return "html" as const;
  return "text" as const;
}
