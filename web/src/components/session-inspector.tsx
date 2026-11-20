// The desktop inspector: a card at the right of the chat with where the session runs, what fills
// its context, the plan's windows, this run's cost and the actions a phone keeps in its sheets.
import * as React from "react";
import {
  ArrowClockwise, ArrowsInLineVertical, FolderOpen, GitBranch, PencilSimple, Sparkle, Terminal, Trash, X,
} from "@phosphor-icons/react/ssr";
import { baseName, tokens } from "@/lib/format";
import type { Plan } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { BackgroundTasks, type BackgroundTask } from "./background-tasks";
import { ContextChart, PlanRings, RunStats, Section, type ContextUsage, type Cost } from "./session-insights";

export const INSPECTOR_WIDTH = 320;

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
  context: ContextUsage | null; cost: Cost | null; cwd?: string;
  online: boolean; open: boolean; plan: Plan | null; running: boolean; session: string; tasks: BackgroundTask[];
  onClose: () => void; onCompact: () => void; onFiles: () => void; onRemove: () => void; onCopyResume: () => void; onFork: () => void; onRename: () => void; onRestart: () => void; onWindow: () => void;
}) {
  const { context, cost, cwd, online, open, plan, running, session, tasks } = props;
  const state = !online ? { label: "離線", dot: "bg-caution" } : running ? { label: "執行中", dot: "bg-contrast motion-safe:animate-pulse" } : open ? { label: "待命", dot: "bg-[var(--viz-3)]" } : { label: "未啟動", dot: "bg-ink-faint" };
  return (
    <aside aria-label="對話資訊" className="preview-in absolute inset-y-0 right-0 z-20 flex p-3 pl-0" style={{ width: INSPECTOR_WIDTH }}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-clip rounded-panel border border-line bg-surface-solid shadow-panel">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line pl-4 pr-2">
          <span aria-hidden className={cn("size-2 rounded-full", state.dot)} />
          <span className="flex-1 text-[0.875rem] font-medium">{state.label}</span>
          <Button aria-label="收起資訊欄" onClick={props.onClose} size="icon-sm" title="收起資訊欄" variant="ghost"><X weight="bold" /></Button>
        </header>
        <div className="grid min-h-0 flex-1 content-start gap-7 overflow-y-auto overscroll-contain px-4 pb-5 pt-4">
          <button className="-mx-2 -mt-1 flex min-w-0 items-center gap-3 rounded-tile px-2 py-2 text-left outline-none transition-colors duration-[var(--motion-control)] hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]" onClick={props.onFiles} title={cwd} type="button">
            <span className="grid size-9 shrink-0 place-items-center rounded-tile bg-surface-raised text-ink-muted"><FolderOpen className="size-[1.125rem]" /></span>
            <span className="grid min-w-0 leading-tight">
              <span className="truncate text-[0.9375rem] font-medium">{baseName(cwd)}</span>
              <span className="truncate text-[0.75rem] text-ink-faint">{cwd}</span>
            </span>
          </button>

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

          <Section title="本次執行">
            <RunStats cost={cost} />
          </Section>

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
