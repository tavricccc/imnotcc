import * as React from "react";
import { CaretRight, Robot, Stop, Terminal } from "@phosphor-icons/react/ssr";
import { send, subscribe } from "@/lib/socket";
import { cn } from "@/lib/utils";
import { AutoHeight, Popover } from "@/ui/popover";
import { duration, useNow } from "./turn";

/** One piece of background work, as the server lists it (shells, agents, monitors). */
export interface BackgroundTask {
  id: string; type: string; agent: string | null; description: string;
  command?: string | null; // the shell command, or an agent's prompt
  startedAt?: number;
}

const isShell = (t: BackgroundTask) => t.type === "local_bash" || t.type === "monitor" || /bash|shell|monitor/i.test(t.type);

/**
 * A quiet "N 個背景工作" label with a breathing dot; it opens the list. Each row reads as
 * icon, name and how long it has run; opened, it shows the command and, for a shell, its output.
 */
export function BackgroundTasks({ className, session, tasks }: { className?: string; session: string; tasks: BackgroundTask[] }) {
  const [open, setOpen] = React.useState(false);
  const [shown, setShown] = React.useState<string | null>(null);
  // A task that ended is no longer listed, so its output closes with it.
  React.useEffect(() => { if (shown && !tasks.some((t) => t.id === shown)) setShown(null); }, [tasks, shown]);
  React.useEffect(() => { if (!tasks.length) setOpen(false); }, [tasks.length]);
  if (!tasks.length) return null;
  return (
    <Popover
      align="start"
      className="w-[min(30rem,calc(100vw-2rem))] p-1.5"
      onOpenChange={setOpen}
      open={open}
      side="top"
      trigger={(
        <button
          className={cn("flex h-7 items-center gap-2 rounded-md px-2 text-[0.8125rem] text-ink-muted outline-none transition-colors duration-[var(--motion-control)] hover:bg-surface-raised hover:text-ink focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]", className)}
          type="button"
        >
          <span aria-hidden className="relative grid size-2 place-items-center">
            <span className="absolute size-2 rounded-full bg-accent-ink opacity-50 motion-safe:animate-ping" />
            <span className="size-1.5 rounded-full bg-accent-ink" />
          </span>
          {tasks.length} 個背景工作
        </button>
      )}
    >
      <AutoHeight>
        <ul className="grid gap-0.5">
          {tasks.map((t) => (
            <TaskRow key={t.id} onToggle={() => setShown((s) => (s === t.id ? null : t.id))} open={shown === t.id} session={session} task={t} />
          ))}
        </ul>
      </AutoHeight>
    </Popover>
  );
}

function TaskRow({ onToggle, open, session, task }: { onToggle: () => void; open: boolean; session: string; task: BackgroundTask }) {
  const shell = isShell(task);
  const Icon = shell ? Terminal : Robot;
  const [stopping, setStopping] = React.useState(false);
  const now = useNow(true);
  return (
    <li className="grid">
      <div className="flex items-center gap-1">
        <button
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[0.875rem] outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          onClick={onToggle}
          type="button"
        >
          <CaretRight className={cn("size-3 shrink-0 text-ink-faint motion-safe:transition-transform", open && "rotate-90")} weight="bold" />
          <Icon className="size-4 shrink-0 text-ink-muted" />
          <span className="min-w-0 flex-1 truncate">{task.description || task.agent || task.type}</span>
          {task.startedAt ? <span className="shrink-0 text-[0.75rem] tabular-nums text-ink-faint">{duration(now - task.startedAt)}</span> : null}
        </button>
        <button
          aria-label="停止這個工作"
          className="grid size-7 shrink-0 place-items-center rounded-md text-ink-faint outline-none hover:bg-surface-raised hover:text-danger focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-40"
          disabled={stopping}
          onClick={() => { setStopping(true); send(session, { t: "task-stop", task: task.id }); }}
          title="停止"
          type="button"
        >
          <Stop className="size-3.5" weight="fill" />
        </button>
      </div>
      {open ? (
        <div className="mx-1 mb-1 mt-0.5 grid gap-1.5">
          {task.agent ? <p className="px-1.5 text-[0.75rem] text-ink-faint">{task.agent}</p> : null}
          {task.command ? (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface-raised px-2.5 py-2 font-mono text-[0.75rem] leading-relaxed text-ink">
              {shell ? <span className="select-none text-ink-faint">$ </span> : null}{task.command}
            </pre>
          ) : null}
          {shell ? <TaskOutput session={session} task={task.id} /> : null}
        </div>
      ) : null}
    </li>
  );
}

/** The end of a shell's output, read again every second while it is open. */
function TaskOutput({ session, task }: { session: string; task: string }) {
  const [out, setOut] = React.useState<{ output: string; truncated: boolean } | null>(null);
  const box = React.useRef<HTMLPreElement>(null);
  const stuck = React.useRef(true);
  React.useEffect(() => {
    const off = subscribe(session, (m: any) => {
      if (m.kind === "task-output" && m.task === task) setOut({ output: m.output, truncated: m.truncated });
    });
    const ask = () => send(session, { t: "task-output", task });
    ask();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") ask(); }, 1000);
    return () => { off(); window.clearInterval(timer); };
  }, [session, task]);
  // Stays at the newest line unless scrolled up.
  React.useLayoutEffect(() => {
    const el = box.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [out]);
  return (
    <pre
      className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface-raised px-2.5 py-2 font-mono text-[0.75rem] leading-relaxed text-ink-muted"
      onScroll={(e) => { const el = e.currentTarget; stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 16; }}
      ref={box}
    >
      {out == null ? "讀取中…" : (
        <>
          {out.truncated ? <span className="text-ink-faint">…只顯示最後 8 KB{"\n"}</span> : null}
          {out.output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "") || "（還沒有輸出）"}
        </>
      )}
    </pre>
  );
}
