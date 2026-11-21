// The desktop inspector: a panel at the right of the chat with where the session runs, what fills
// its context, the plan's windows, this run's cost, the latest turn's changed files and the actions a phone keeps in its sheets.
import * as React from "react";
import {
  ArrowClockwise, ArrowsInLineVertical, FolderOpen, GitBranch, PencilSimple, Sparkle, Terminal, Trash, X,
} from "@phosphor-icons/react/ssr";
import { baseName, tokens } from "@/lib/format";
import type { Plan } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { prefs } from "@/lib/prefs";
import { useStore } from "@/lib/store-core";
import { useEdgeResize } from "./resize-edge";
import type { FileChange } from "@/lib/turns";
import { Stats } from "./turn";
import { BackgroundTasks, type BackgroundTask } from "./background-tasks";
import { ContextChart, PlanRings, Section, type ContextUsage, type Cost } from "./session-insights";

const MIN_INSPECTOR_WIDTH = 280;
/** Kept between a usable minimum and a third of the window. */
export const clampInspectorWidth = (w: number) => Math.round(Math.min(Math.max(w, MIN_INSPECTOR_WIDTH), Math.max(MIN_INSPECTOR_WIDTH, window.innerWidth / 3)));

const sum = (files: FileChange[]) => files.reduce((a, f) => ({ added: a.added + (f.added ?? 0), removed: a.removed + (f.removed ?? 0) }), { added: 0, removed: 0 });

const ACTION = "flex min-w-0 flex-col items-center gap-1.5 rounded-tile bg-surface-raised px-1 py-2.5 text-[0.75rem] text-ink-muted outline-none transition-[background-color,color,transform] duration-[var(--motion-control)] hover:bg-surface-pressed hover:text-ink active:scale-[var(--motion-press-scale)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-[1.125rem]";

function Action({ danger, disabled, icon, label, onClick }: { danger?: boolean; disabled?: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      
      className={cn(ACTION, danger && "hover:text-danger")} disabled={disabled} onClick={onClick} type="button"
    >
      {icon}
      <span className="w-full truncate text-center">{label}</span>
    </button>
  );
}

export function SessionInspector(props: {
  changes: { turn: string; files: FileChange[] } | null; context: ContextUsage | null; cost: Cost | null; cwd?: string;
  online: boolean; open: boolean; plan: Plan | null; running: boolean; session: string; tasks: BackgroundTask[];
  onClose: () => void; onOpenDiff: (turn: string, path: string, files: FileChange[]) => void; onCompact: () => void; onFiles: () => void; onRemove: () => void; onCopyResume: () => void; onFork: () => void; onRename: () => void; onRestart: () => void; onWindow: () => void;
}) {
  const { changes, context, cost, cwd, open, plan, session, tasks } = props;
  const resize = useEdgeResize(useStore(prefs).inspectorWidth, clampInspectorWidth, (w) => prefs.set({ inspectorWidth: w }));
  React.useEffect(() => {
    document.documentElement.style.setProperty("--inspector-width", `${resize.shown}px`);
    if (resize.dragging) document.documentElement.style.setProperty("--preview-motion", "0ms");
    else document.documentElement.style.removeProperty("--preview-motion");
  }, [resize.shown, resize.dragging]);
  React.useEffect(() => () => { document.documentElement.style.removeProperty("--inspector-width"); }, []);
  return (
    <aside aria-label="對話資訊" className="preview-in absolute inset-y-0 right-0 z-20 flex" style={{ width: resize.shown }}>
      {resize.handle}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-clip bg-surface-solid">
        <div className="grid min-h-0 flex-1 content-start gap-7 overflow-y-auto overscroll-contain px-4 pb-5 pt-3">
          <div className="flex min-w-0 items-center gap-1">
            <button className="-ml-2 flex min-w-0 flex-1 items-center gap-3 rounded-tile px-2 py-2 text-left outline-none transition-colors duration-[var(--motion-control)] hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]" onClick={props.onFiles} title={cwd} type="button">
              <span className="grid size-9 shrink-0 place-items-center rounded-tile bg-surface-raised text-ink-muted"><FolderOpen className="size-[1.125rem]" /></span>
              <span className="grid min-w-0 leading-tight">
                <span className="truncate text-[0.9375rem] font-medium">{baseName(cwd)}</span>
                <span className="truncate text-[0.75rem] text-ink-faint">{cwd}</span>
              </span>
            </button>
            <Button aria-label="收起資訊欄" className="shrink-0 self-center" onClick={props.onClose} size="icon-sm" title="收起資訊欄" variant="ghost"><X weight="bold" /></Button>
          </div>

          <Section
            action={(
              <button className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[0.75rem] tabular-nums text-ink-muted outline-none hover:bg-surface-raised hover:text-ink focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]" onClick={props.onWindow} title="自動壓縮門檻" type="button">
                <ArrowsInLineVertical className="size-3.5" />{context ? tokens(context.max) : "門檻"}
              </button>
            )}
            title="Context"
          >
            <ContextChart context={context} />
          </Section>

          <Section title="方案用量">
            <PlanRings fiveHour={plan?.fiveHour} sevenDay={plan?.sevenDay} />
          </Section>

          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[0.75rem] font-medium uppercase tracking-wide text-ink-faint">本次費用</h3>
            <span className="text-[0.875rem] font-medium tabular-nums">{cost ? `$${cost.usd.toFixed(2)}` : "—"}</span>
          </div>

          {changes?.files.length ? (
            <Section action={<span className="text-[0.75rem]"><Stats {...sum(changes.files)} /></span>} title={`最近變更 · ${changes.files.length}`}>
              <ul className="-mx-2 -mt-1 grid text-[0.8125rem]">
                {changes.files.slice(0, 8).map((f) => (
                  <li className="min-w-0" key={f.path}>
                    <button className="flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-left outline-none transition-colors duration-[var(--motion-control)] hover:bg-surface-raised focus-visible:bg-surface-raised" onClick={() => props.onOpenDiff(changes.turn, f.path, changes.files)} title={f.path} type="button">
                      <span className="min-w-0 flex-1 truncate">{baseName(f.path)}</span>
                      <Stats {...f} />
                    </button>
                  </li>
                ))}
                {changes.files.length > 8 ? <li className="px-2 py-1.5 text-ink-faint">另外 {changes.files.length - 8} 個檔案</li> : null}
              </ul>
            </Section>
          ) : null}

          {tasks.length ? (
            <Section title="背景工作">
              <BackgroundTasks className="-mx-2 justify-self-start" session={session} tasks={tasks} />
            </Section>
          ) : null}

          <Section title="動作">
            <div className="grid grid-cols-3 gap-2">
              <Action icon={<Sparkle />} label="壓縮" onClick={props.onCompact} />
              <Action icon={<GitBranch />} label="分支" onClick={props.onFork} />
              <Action icon={<PencilSimple />} label="改名" onClick={props.onRename} />
              <Action disabled={!open} icon={<ArrowClockwise />} label="重新啟動" onClick={props.onRestart} />
              <Action icon={<Terminal />} label="接續指令" onClick={props.onCopyResume} />
              <Action danger icon={<Trash />} label="移除" onClick={props.onRemove} />
            </div>
          </Section>
        </div>
      </div>
    </aside>
  );
}
