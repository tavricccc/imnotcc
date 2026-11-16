import * as React from "react";
import { prefs } from "@/lib/prefs";
import { useStore } from "@/lib/store-core";
import { animate } from "motion/react";
import { Brain, CaretRight, FileText, Globe, ListChecks, MagnifyingGlass, PencilSimple, PuzzlePiece, Question, Robot, TerminalWindow, Wrench, X } from "@phosphor-icons/react/ssr";
import { motionEasing, motionSeconds } from "@/generated/motion-tokens";
import { toolSummary, type Item } from "@/lib/transcript";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Thumb } from "./lightbox";
import { FileIcon } from "./file-icon";
import { SessionContext } from "@/lib/session-images";
import { resolveFile, type FileInfo } from "@/lib/file-mentions";
import { openPreview } from "@/lib/preview";
import { baseName } from "@/lib/format";
import { DiffRows, editRows } from "./diff-view";

const LIMIT = 4000;
// Allow wheel scrolling to reach the chat when a tool's input or output reaches its edge.
const codeClass = "max-h-96 overflow-auto overscroll-y-auto! whitespace-pre-wrap break-words rounded-tile bg-surface-raised p-3 font-mono text-[0.8125rem] leading-relaxed";

function inputText(tool: Item) {
  const i = tool.input ?? {};
  if (typeof i.command === "string") return i.command;
  return JSON.stringify(i, null, 2);
}

// How long a reveal takes grows with how far it travels, between these heights, so a long
// output opens as visibly as a short one instead of jumping. Both ends sit on the motion ladder.
const SHORT = 80;
const TALL = 640;
function revealSeconds(height: number, opening: boolean) {
  const [from, to] = opening ? [motionSeconds.control, motionSeconds.sheet] : [motionSeconds.controlExit, motionSeconds.sheetExit];
  const t = Math.min(1, Math.max(0, (height - SHORT) / (TALL - SHORT)));
  return from + (to - from) * t;
}

/** Content that grows open under its line and folds away again, taking longer the taller it is. */
export function Reveal({ children, open }: { children: React.ReactNode; open: boolean }) {
  const reducedMotion = useStore(prefs).reduceMotion;
  const [shown, setShown] = React.useState(open);
  const box = React.useRef<HTMLDivElement>(null);
  const first = React.useRef(true);
  if (open && !shown) setShown(true);
  React.useLayoutEffect(() => {
    const el = box.current;
    const initial = first.current;
    first.current = false;
    if (!el) return;
    // Open from the start, as a running turn is: it is simply there.
    if (initial && open) { el.style.height = "auto"; el.style.opacity = "1"; return; }
    let cancelled = false;
    const height = el.scrollHeight;
    const from = el.getBoundingClientRect().height;
    const options = { duration: reducedMotion ? 0 : revealSeconds(height, open), ease: open ? motionEasing.arrive : motionEasing.depart };
    const run = open
      ? animate(el, { height: [from, height], opacity: [Number(getComputedStyle(el).opacity), 1] }, options)
      : animate(el, { height: [from, 0], opacity: 0 }, options);
    void run.then(() => {
      if (cancelled) return;
      if (open) el.style.height = "auto";
      else setShown(false);
    });
    return () => { cancelled = true; run.stop(); };
    // Runs when it is asked to open or close; the first paint of a closed reveal draws nothing.
  }, [open, shown, reducedMotion]);
  if (!shown) return null;
  return <div className="overflow-clip" ref={box} style={{ height: 0, opacity: 0 }}>{children}</div>;
}

/** What a step took in and gave back: the full thought, or a tool's input and output. */
export function ToolDetail({ tool }: { tool: Item }) {
  const [full, setFull] = React.useState(false);
  if (tool.type === "thinking") {
    return <p className="whitespace-pre-wrap rounded-tile bg-surface-raised p-3 text-sm leading-relaxed text-ink-muted [overflow-wrap:anywhere]" data-selectable="">{tool.text}</p>;
  }
  const result = tool.result ?? "";
  const change = edits(tool);
  return (
    <div className="grid min-w-0 gap-2" data-selectable="">
      {typeof tool.input?.file_path === "string" ? <FilePath path={tool.input.file_path} /> : null}
      {change ? <DiffRows name={String(tool.input?.file_path ?? "")} rows={editRows(change)} /> : <pre className={codeClass}>{inputText(tool)}</pre>}
      {tool.done && (result || !tool.images?.length) ? (
        <pre className={cn(codeClass, tool.error && "text-danger")}>{(full || result.length <= LIMIT ? result : `${result.slice(0, LIMIT)}…`) || "（沒有輸出）"}</pre>
      ) : null}
      {tool.done && !full && result.length > LIMIT ? (
        <Button className="justify-self-start" onClick={() => setFull(true)} size="sm" variant="ghost">顯示全部</Button>
      ) : null}
    </div>
  );
}

/** What an Edit, MultiEdit or Write changed, as old and new text; null for other tools. */
function edits(tool: Item): { old: string; new: string }[] | null {
  const i = tool.input ?? {};
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  if (tool.name === "Edit") return [{ old: str(i.old_string), new: str(i.new_string) }];
  if (tool.name === "Write") return [{ old: "", new: str(i.content) }];
  if (tool.name === "MultiEdit" && Array.isArray(i.edits)) return (i.edits as Record<string, unknown>[]).map((e) => ({ old: str(e.old_string), new: str(e.new_string) }));
  return null;
}

/** The file a tool read or wrote: its path, which opens it in the preview panel while it is still there. */
function FilePath({ path }: { path: string }) {
  const session = React.useContext(SessionContext);
  const [info, setInfo] = React.useState<FileInfo | null>(null);
  React.useEffect(() => {
    let live = true;
    if (session) void resolveFile(session, path).then((f) => { if (live) setInfo(f && f.kind !== "dir" ? f : null); });
    return () => { live = false; };
  }, [session, path]);
  const cls = "flex min-w-0 items-center gap-1.5 justify-self-start font-mono text-[0.8125rem] text-ink-muted";
  if (!session || !info) return <span className={cls}><span className="truncate">{path}</span></span>;
  return (
    <button className={cn(cls, "rounded-md underline-offset-2 hover:text-ink hover:underline")} onClick={() => openPreview({ kind: "file", session, path: info.path })} title="在側邊打開" type="button">
      <FileIcon className="size-4 shrink-0" kind={info.kind} name={baseName(path)} /><span className="truncate">{path}</span>
    </button>
  );
}

/** The images tools gave back, in view as soon as they arrive rather than behind the step's detail. */
export function ToolImages({ tools }: { tools: Item[] }) {
  const images = tools.flatMap((t) => t.images ?? []);
  if (!images.length) return null;
  return <div className="flex flex-wrap gap-2 py-1">{images.map((src, i) => <Thumb key={i} src={src} />)}</div>;
}

/** A tool call as one quiet line; it opens to show what went in and what came back. */
export function ToolCard({ tool }: { tool: Item }) {
  const [open, setOpen] = React.useState(false);
  const thinking = tool.type === "thinking";
  const Icon = thinking ? Brain : toolIcon(tool.name);
  return (
    <div className="content-in grid min-w-0 gap-2">
      <button
        aria-expanded={open}
        className={cn(
          "flex h-9 min-w-0 items-center gap-2 rounded-full bg-surface-raised px-3.5 text-left text-sm text-ink-muted outline-none transition-[background-color] duration-[var(--motion-control)] ease-[var(--ease-move)] hover:bg-surface-pressed focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]",
          tool.error && "text-danger",
        )}
        onClick={() => setOpen(!open)}
        type="button"
      >
        <Icon aria-hidden className="size-4 shrink-0" />
        <span className="shrink-0 font-semibold text-ink">{thinking ? "思考" : toolName(tool)}</span>
        <span className={cn("min-w-0 flex-1 truncate text-[0.8125rem]", !thinking && "font-mono")}>{thinking ? firstLine(tool.text) : toolSummary(tool.name, tool.input)}</span>
        {tool.error ? <X aria-label="失敗" className="size-4 shrink-0" weight="bold" /> : null}
        <CaretRight aria-hidden className={cn("size-3.5 shrink-0 text-ink-faint transition-transform duration-[var(--motion-control)] ease-[var(--ease-move)]", open && "rotate-90")} weight="bold" />
      </button>
      <ToolImages tools={[tool]} />
      <Reveal open={open}><ToolDetail tool={tool} /></Reveal>
    </div>
  );
}

export const toolName = (t: Item) => (t.name ?? "").replace(/^mcp__(.+?)__/, (_, s: string) => `${s.split("__").pop()} · `);
export const firstLine = (text?: string) => (text ?? "").trim().split(/\r?\n/)[0];

export function toolIcon(name?: string) {
  switch (name) {
    case "Bash": case "PowerShell": return TerminalWindow;
    case "Read": return FileText;
    case "Write": case "Edit": case "MultiEdit": case "NotebookEdit": return PencilSimple;
    case "Glob": case "Grep": return MagnifyingGlass;
    case "WebFetch": case "WebSearch": return Globe;
    case "Task": case "Agent": return Robot;
    case "Skill": return PuzzlePiece;
    case "TodoWrite": return ListChecks;
    case "AskUserQuestion": return Question;
    default: return Wrench;
  }
}
