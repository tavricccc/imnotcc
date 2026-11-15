// The preview panel: one file, or one file's change in a turn. On a wide screen it floats inside
// the right edge of the main card and shifts the chat column over; narrower, it is a sheet.
import * as React from "react";
import { Code, Eye, X } from "@phosphor-icons/react/ssr";
import { useStore } from "@/lib/store-core";
import { closePreview, preview, type PreviewTarget } from "@/lib/preview";
import { prefs } from "@/lib/prefs";
import { baseName } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Sheet } from "@/ui/sheet";
import { FileIcon } from "./file-icon";
import { FileBody, OpenPage, OpenRaw, useFile } from "./preview-views";
import { DiffBody } from "./diff-view";

/** Wide enough for the panel beside the chat rather than over it. */
const WIDE_QUERY = "(min-width: 80rem)";
export const MIN_PREVIEW_WIDTH = 360;

function subscribe(onChange: () => void) {
  const q = window.matchMedia(WIDE_QUERY);
  q.addEventListener("change", onChange);
  return () => q.removeEventListener("change", onChange);
}
export const useWidePreview = () => React.useSyncExternalStore(subscribe, () => window.matchMedia(WIDE_QUERY).matches, () => false);

/** The panel's width, kept to at most half the window. */
export const clampPreviewWidth = (w: number) => Math.round(Math.min(Math.max(w, MIN_PREVIEW_WIDTH), window.innerWidth * 0.5));

export function PreviewPanel() {
  const { target, version } = useStore(preview);
  const wide = useWidePreview();
  // The last target stays shown while the sheet slides away.
  const last = React.useRef<PreviewTarget | null>(target);
  if (target) last.current = target;
  const shown = target ?? last.current;
  const [source, setSource] = React.useState(false);
  React.useEffect(() => setSource(false), [shown?.path]);
  // Read once here for both the title and the body; a diff reads its own.
  const file = useFile(shown?.session, shown?.kind === "file" ? shown.path : undefined, version);
  const toggleSource = () => setSource(!source);

  if (wide) return target ? <SidePanel file={file} source={source} target={target} toggleSource={toggleSource} /> : null;
  if (!shown) return null;
  return (
    <Sheet layout="record" onOpenChange={(o) => { if (!o) closePreview(); }} open={!!target} size="screen"
      title={<Title file={file} source={source} target={shown} toggleSource={toggleSource} />}>
      <Body file={file} source={source} target={shown} />
    </Sheet>
  );
}

type FileState = ReturnType<typeof useFile>;

function SidePanel({ file, source, target, toggleSource }: { file: FileState; source: boolean; target: PreviewTarget; toggleSource: () => void }) {
  const width = useStore(prefs).previewWidth;
  const drag = React.useRef<{ id: number; x: number; start: number } | null>(null);
  const [dragging, setDragging] = React.useState<number | null>(null);
  const shown = clampPreviewWidth(dragging ?? width);
  React.useEffect(() => {
    document.documentElement.style.setProperty("--preview-width", `${shown}px`);
  }, [shown]);
  React.useEffect(() => {
    if (dragging === null) document.documentElement.style.removeProperty("--preview-motion");
    else document.documentElement.style.setProperty("--preview-motion", "0ms");
  }, [dragging]);
  React.useEffect(() => () => {
    document.documentElement.style.removeProperty("--preview-width");
    document.documentElement.style.removeProperty("--preview-motion");
  }, []);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) closePreview(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const finish = () => {
    if (!drag.current) return;
    drag.current = null;
    if (dragging !== null) prefs.set({ previewWidth: clampPreviewWidth(dragging) });
    setDragging(null);
  };
  return (
    <aside aria-label="預覽" className="preview-in absolute inset-y-0 right-0 z-40 flex p-3 pl-0" style={{ width: shown }}>
      <div aria-label="調整預覽寬度" aria-orientation="vertical" aria-valuenow={shown}
        className="w-3 shrink-0 touch-none cursor-col-resize rounded-full outline-none hover:bg-accent-soft focus-visible:bg-accent-soft active:bg-accent-soft"
        onKeyDown={(e) => {
          const step = { ArrowLeft: 24, ArrowRight: -24 }[e.key];
          if (step) prefs.set({ previewWidth: clampPreviewWidth(shown + step) });
        }}
        onLostPointerCapture={finish}
        onPointerCancel={finish}
        onPointerDown={(e) => {
          if (!e.isPrimary || e.button !== 0) return;
          drag.current = { id: e.pointerId, x: e.clientX, start: shown };
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragging(shown);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d?.id === e.pointerId) setDragging(clampPreviewWidth(d.start + d.x - e.clientX));
        }}
        onPointerUp={finish}
        role="separator" tabIndex={0} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-clip rounded-panel border border-line bg-surface-solid shadow-panel">
        <header className="flex shrink-0 items-start gap-2 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1 pt-1"><Title file={file} source={source} target={target} toggleSource={toggleSource} /></div>
          <Button aria-label="關閉預覽" onClick={closePreview} size="icon-sm" variant="ghost"><X weight="bold" /></Button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto overscroll-contain p-4">
          <Body file={file} source={source} target={target} />
        </div>
      </div>
    </aside>
  );
}

/** The file's name and where it is, with what can be done to it. */
function Title({ file, source, target, toggleSource }: { file: FileState; source: boolean; target: PreviewTarget; toggleSource: () => void }) {
  const kind = file.data?.kind ?? "text";
  const name = file.data?.name ?? baseName(target.path);
  return (
    <div className="flex min-w-0 items-start gap-2">
      <FileIcon className="mt-0.5 size-5 shrink-0 text-ink-muted" kind={kind} name={name} />
      <div className="grid min-w-0 flex-1">
        <span className="truncate text-[0.9375rem] font-semibold">{target.kind === "diff" ? `${name} 的變更` : name}</span>
        <span className="truncate text-[0.8125rem] font-normal text-ink-muted" data-selectable="" title={target.path}>{target.path}</span>
      </div>
      {target.kind === "file" && kind === "markdown" ? (
        <Button aria-label={source ? "顯示排版" : "顯示原始碼"} aria-pressed={source} className={cn(source && "text-ink")} onClick={toggleSource} size="icon-sm" title={source ? "顯示排版" : "顯示原始碼"} variant="ghost">
          {source ? <Eye /> : <Code />}
        </Button>
      ) : null}
      {target.kind === "file" && file.data?.kind === "html" ? <OpenPage path={target.path} session={target.session} />
        : target.kind === "file" && file.data && file.data.kind !== "dir" ? <OpenRaw hostPath={file.data.hostPath} kind={file.data.kind} name={file.data.name} path={target.path} session={target.session} size={file.data.size} /> : null}
    </div>
  );
}

function Body({ file, source, target }: { file: FileState; source: boolean; target: PreviewTarget }) {
  if (target.kind === "diff") return <DiffBody target={target} />;
  return <FileBody file={file} line={target.line} session={target.session} source={source} />;
}
