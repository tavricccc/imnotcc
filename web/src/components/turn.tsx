import * as React from "react";
import { Brain, CaretDown, CaretRight, PlusMinus } from "@phosphor-icons/react/ssr";
import { toolSummary, type Item } from "@/lib/transcript";
import { cn } from "@/lib/utils";
import { Markdown } from "./markdown";
import { firstLine, Reveal, ToolDetail, toolIcon, ToolImages, toolName } from "./tool-card";
import { baseName, isStep, pathOf, type FileChange } from "@/lib/turns";

// A turn, read the way Codex shows one: the work before the answer folds into
// "已處理 2 分鐘 26 秒", tool calls read as past-tense lines, and the files the
// turn edited close it as a short list.

function duration(ms: number) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分鐘${s % 60 ? ` ${s % 60} 秒` : ""}`;
  return `${Math.floor(m / 60)} 小時${m % 60 ? ` ${m % 60} 分鐘` : ""}`;
}

function useNow(live: boolean) {
  const [now, setNow] = React.useState(Date.now);
  React.useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return now;
}

/** The work of one turn behind a single line; it stays open while the turn runs. */
export function TurnWork({ end, items, live, start }: { end?: number; items: Item[]; live: boolean; start?: number }) {
  const [toggled, setToggled] = React.useState<boolean | null>(null);
  const open = toggled ?? live;
  const now = useNow(live);
  const took = start ? (live ? now : end ?? start) - start : null;
  const label = live
    ? `處理中${took != null ? ` ${duration(took)}` : ""}`
    : took != null ? `已處理 ${duration(took)}` : `已處理 ${items.filter(isStep).length} 步`;
  const Caret = open ? CaretDown : CaretRight;
  return (
    <div className="content-in grid min-w-0">
      <button
        aria-expanded={open}
        className="flex min-w-0 items-center gap-1.5 justify-self-stretch border-b border-line pb-2 text-left text-sm tabular-nums text-ink-faint outline-none transition-colors duration-[var(--motion-control)] hover:text-ink-muted focus-visible:text-ink"
        onClick={() => setToggled(!open)}
        type="button"
      >
        <span className={cn(live && "shimmer")}>{label}</span>
        <Caret aria-hidden className="size-3.5" weight="bold" />
      </button>
      <Reveal open={open}>
        <div className="grid min-w-0 gap-3 pt-3">
          {segments(items).map((seg) => Array.isArray(seg)
            ? <StepRun key={seg[0].key} steps={seg} />
            : seg.type === "assistant"
              ? <Markdown className="[overflow-wrap:anywhere]" key={seg.key} text={seg.text ?? ""} />
              : <p className="text-[0.8125rem] text-ink-muted" key={seg.key}>{seg.text}</p>)}
        </div>
      </Reveal>
    </div>
  );
}

function segments(items: Item[]): (Item | Item[])[] {
  const out: (Item | Item[])[] = [];
  for (const it of items) {
    const prev = out.at(-1);
    if (isStep(it) && Array.isArray(prev)) prev.push(it);
    else out.push(isStep(it) ? [it] : it);
  }
  return out;
}

// A verb for the line itself, and what the kind of work is called when a run of steps folds behind its latest.
interface Kind { done: string; doing: string; noun: string }
const KINDS: Record<string, Kind> = {
  edit: { done: "已編輯", doing: "正在編輯", noun: "檔案" },
  run: { done: "已執行", doing: "正在執行", noun: "指令" },
  read: { done: "已讀取", doing: "正在讀取", noun: "檔案" },
  search: { done: "已搜尋", doing: "正在搜尋", noun: "檔案" },
  web: { done: "已查詢", doing: "正在查詢", noun: "網路" },
  agent: { done: "已委派", doing: "正在委派", noun: "代理" },
  skill: { done: "已使用", doing: "正在使用", noun: "技能" },
  todo: { done: "已更新", doing: "正在更新", noun: "待辦" },
  ask: { done: "已詢問", doing: "正在詢問", noun: "你" },
  think: { done: "思考", doing: "正在思考", noun: "" },
  other: { done: "已呼叫", doing: "正在呼叫", noun: "工具" },
};
const running = (step: Item) => step.type === "tool" && !step.done;

function kindOf(step: Item): string {
  if (step.type === "thinking") return "think";
  switch (step.name) {
    case "Edit": case "MultiEdit": case "Write": case "NotebookEdit": return "edit";
    case "Bash": case "PowerShell": return "run";
    case "Read": return "read";
    case "Glob": case "Grep": return "search";
    case "WebFetch": case "WebSearch": return "web";
    case "Task": case "Agent": return "agent";
    case "Skill": return "skill";
    case "TodoWrite": return "todo";
    case "AskUserQuestion": return "ask";
    default: return "other";
  }
}

function Stats({ added, removed }: { added: number | null; removed: number | null }) {
  if (added == null || removed == null) return <span className="shrink-0 text-ink-faint">二進位</span>;
  return (
    <span className="shrink-0 tabular-nums">
      <span className="text-positive">+{added}</span> <span className="text-danger">−{removed}</span>
    </span>
  );
}

/** Steps in a row: one shows as its own line, several fold behind the latest, e.g. "已執行指令". */
function StepRun({ steps }: { steps: Item[] }) {
  const [open, setOpen] = React.useState(false);
  if (steps.length === 1) return <div className="grid min-w-0"><StepRow step={steps[0]} /><ToolImages tools={steps} /></div>;
  // Named by its latest tool: a thought is never the headline unless the run is only thoughts.
  const latest = steps.findLast((s) => s.type === "tool") ?? steps.at(-1)!;
  const kind = KINDS[kindOf(latest)];
  const Icon = latest.type === "thinking" ? Brain : toolIcon(latest.name);
  const Caret = open ? CaretDown : CaretRight;
  return (
    <div className="grid min-w-0">
      <button aria-expanded={open} className={lineClass} onClick={() => setOpen(!open)} type="button">
        <Icon aria-hidden className="size-4 shrink-0 text-ink-faint" />
        <span className={cn("min-w-0 truncate", running(latest) && "shimmer")}>{running(latest) ? kind.doing : kind.done}{kind.noun}</span>
        <Caret aria-hidden className="size-3.5 shrink-0 text-ink-faint" weight="bold" />
      </button>
      <Reveal open={open}>
        <ScrollFade className="max-h-80 pt-0.5">
          {steps.map((step) => <StepRow key={step.key} step={step} />)}
        </ScrollFade>
      </Reveal>
      <ToolImages tools={steps} />
    </div>
  );
}

const FADE = "1.5rem";

/** A capped list that fades out at whichever edge still has more to scroll to. */
function ScrollFade({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [edges, setEdges] = React.useState({ top: false, bottom: false });
  const measure = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const top = el.scrollTop > 1;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    setEdges((e) => (e.top === top && e.bottom === bottom ? e : { top, bottom }));
  }, []);
  React.useLayoutEffect(() => {
    measure();
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    return () => observer.disconnect();
  }, [measure, children]);
  const mask = edges.top || edges.bottom
    ? `linear-gradient(to bottom, ${edges.top ? "transparent" : "#000"}, #000 ${FADE}, #000 calc(100% - ${FADE}), ${edges.bottom ? "transparent" : "#000"})`
    : undefined;
  return (
    <div className={cn("grid min-w-0 overflow-y-auto overscroll-y-auto!", className)} onScroll={measure} ref={ref} style={{ maskImage: mask, WebkitMaskImage: mask }}>
      {children}
    </div>
  );
}

const lineClass = "flex min-h-8 min-w-0 items-center gap-2 justify-self-start rounded-md py-1 text-left text-[0.9375rem] text-ink-muted outline-none transition-colors duration-[var(--motion-control)] hover:text-ink focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]";

/** One step as a past-tense line, e.g. "已執行 git status"; it opens onto what went in and came back. */
function StepRow({ step }: { step: Item }) {
  const [open, setOpen] = React.useState(false);
  const kind = kindOf(step);
  const verb = running(step) ? KINDS[kind].doing : KINDS[kind].done;
  const Icon = kind === "think" ? Brain : toolIcon(step.name);
  const target = kind === "think" ? firstLine(step.text)
    : kind === "edit" ? baseName(pathOf(step))
    : kind === "other" ? toolName(step)
    : toolSummary(step.name, step.input);
  return (
    <div className="grid min-w-0">
      <button aria-expanded={open} className={cn(lineClass, "max-w-full", step.error && "text-danger hover:text-danger")} onClick={() => setOpen(!open)} type="button">
        <Icon aria-hidden className="size-4 shrink-0 text-ink-faint" />
        <span className={cn("flex min-w-0 gap-2", running(step) && "shimmer")}>
          <span className="shrink-0">{verb}</span>
          {target ? <span className={cn("min-w-0 truncate", kind === "edit" && "underline decoration-line underline-offset-4")}>{target}</span> : null}
        </span>
        {step.error ? <span className="shrink-0">失敗</span> : null}
      </button>
      <Reveal open={open}><div className="pb-2 pl-6 pt-1"><ToolDetail tool={step} /></div></Reveal>
    </div>
  );
}

const SHOWN = 3;

/** The files a turn changed, as git counted them, with the lines each gained and lost. */
export function FilesCard({ files }: { files: FileChange[] }) {
  const [all, setAll] = React.useState(false);
  const rows = files.map((f) => [f.path, f] as const);
  const total = rows.reduce((a, [, s]) => ({ added: a.added + (s.added ?? 0), removed: a.removed + (s.removed ?? 0) }), { added: 0, removed: 0 });
  const shown = all ? rows : rows.slice(0, SHOWN);
  return (
    <div className="content-in min-w-0 overflow-clip rounded-[1.125rem] border border-line bg-surface-solid shadow-panel">
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-tile bg-surface-raised text-ink-muted"><PlusMinus aria-hidden className="size-4" /></span>
        <div className="grid min-w-0 text-sm">
          <span className="font-semibold text-ink">已變更 {rows.length} 個檔案</span>
          <span className="text-[0.8125rem]"><Stats {...total} /></span>
        </div>
      </div>
      <ul className="grid border-t border-line px-4 py-1.5 text-sm">
        {shown.map(([path, s]) => {
          const name = baseName(path);
          return (
            <li className="flex min-w-0 items-center gap-3 py-1.5" key={path} title={path}>
              <span className="min-w-0 flex-1 truncate text-ink-muted">{path.slice(0, path.length - name.length)}<span className="text-ink">{name}</span></span>
              <Stats {...s} />
            </li>
          );
        })}
      </ul>
      {rows.length > SHOWN ? (
        <button className="flex w-full items-center gap-1.5 px-4 pb-3 text-left text-sm text-ink-muted outline-none hover:text-ink focus-visible:text-ink" onClick={() => setAll(!all)} type="button">
          {all ? "收起" : `顯示另外 ${rows.length - SHOWN} 個檔案`}
          <CaretDown aria-hidden className={cn("size-3.5 transition-transform duration-[var(--motion-control)]", all && "rotate-180")} weight="bold" />
        </button>
      ) : null}
    </div>
  );
}
