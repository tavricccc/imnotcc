import * as React from "react";
import { toolSummary } from "@/lib/transcript";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Input } from "@/ui/field";
import { Panel } from "@/ui/panel";
import { Markdown } from "./markdown";

export interface PermissionRequest { id: string; tool: string; input?: any; reason?: string; blockedPath?: string }
export type Answer = { decision: "allow" | "deny" | "always"; message?: string; answers?: Record<string, string> };

/** A tool call waiting for you. AskUserQuestion is answered here; ExitPlanMode shows the plan. */
export function PermissionCard({ className, onAnswer, req }: { className?: string; onAnswer: (a: Answer) => void; req: PermissionRequest }) {
  return (
    <Panel aria-label={`${req.tool} 等你回覆`} className={cn("content-in grid gap-4 border border-contrast/30", className)} role="group">
      {req.tool === "AskUserQuestion" ? <Questions onAnswer={onAnswer} req={req} />
        : req.tool === "ExitPlanMode" ? <Plan onAnswer={onAnswer} req={req} />
        : <Tool onAnswer={onAnswer} req={req} />}
    </Panel>
  );
}

function Tool({ onAnswer, req }: { onAnswer: (a: Answer) => void; req: PermissionRequest }) {
  const i = req.input ?? {};
  const detail = typeof i.command === "string" ? i.command : toolSummary(req.tool, i) || JSON.stringify(i, null, 2);
  return (
    <>
      <p className="text-base font-semibold">要允許 {req.tool} 嗎？</p>
      <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-tile bg-surface-raised p-3 font-mono text-[0.8125rem]" data-selectable="">{detail}</pre>
      {req.reason || req.blockedPath ? <p className="text-sm text-ink-muted">{req.reason || req.blockedPath}</p> : null}
      <div className="grid grid-cols-2 gap-2">
        <Button onClick={() => onAnswer({ decision: "deny" })}>拒絕</Button>
        <Button onClick={() => onAnswer({ decision: "allow" })} variant="primary">允許</Button>
        <Button className="col-span-2" onClick={() => onAnswer({ decision: "always" })} size="sm" variant="ghost">這個對話都允許</Button>
      </div>
    </>
  );
}

function Plan({ onAnswer, req }: { onAnswer: (a: Answer) => void; req: PermissionRequest }) {
  const [note, setNote] = React.useState("");
  return (
    <>
      <p className="text-base font-semibold">計畫好了，要開始執行嗎？</p>
      <div className="max-h-[40svh] overflow-y-auto rounded-tile bg-surface-raised p-3"><Markdown text={req.input?.plan ?? ""} /></div>
      <Input className="h-11" onChange={(e) => setNote(e.target.value)} placeholder="想改的地方（選填）" value={note} />
      <div className="grid grid-cols-2 gap-2">
        <Button onClick={() => onAnswer({ decision: "deny", message: note || "Keep planning." })}>繼續規劃</Button>
        <Button onClick={() => onAnswer({ decision: "allow" })} variant="primary">開始執行</Button>
      </div>
    </>
  );
}

interface Question { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] }

function Questions({ onAnswer, req }: { onAnswer: (a: Answer) => void; req: PermissionRequest }) {
  const questions: Question[] = req.input?.questions ?? [];
  const [picks, setPicks] = React.useState<Record<string, string[]>>({});
  const [other, setOther] = React.useState<Record<string, string>>({});
  const [step, setStep] = React.useState(0);
  const [moved, setMoved] = React.useState(false);

  function toggle(q: Question, label: string) {
    const now = picks[q.question] ?? [];
    const next = q.multiSelect ? (now.includes(label) ? now.filter((l) => l !== label) : [...now, label]) : [label];
    setPicks({ ...picks, [q.question]: next });
  }

  const answers: Record<string, string> = {};
  for (const q of questions) {
    const chosen = [...(picks[q.question] ?? [])];
    if (other[q.question]?.trim()) chosen.push(other[q.question].trim());
    if (chosen.length) answers[q.question] = chosen.join(", ");
  }
  const complete = questions.every((q) => answers[q.question]);
  const q = questions[step];
  if (!q) return null;
  const last = step === questions.length - 1;

  return (
    <>
      <div className={cn("grid gap-2.5", step > 0 || moved ? "content-in" : undefined)} key={q.question}>
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-base font-semibold">{q.question}</p>
          {questions.length > 1 ? <span className="shrink-0 text-[0.8125rem] tabular-nums text-ink-muted">{step + 1} / {questions.length}</span> : null}
        </div>
        {q.multiSelect ? <p className="text-[0.8125rem] text-ink-muted">可以選多個</p> : null}
        <div className="grid max-h-[40svh] gap-1.5 overflow-y-auto">
          {q.options.map((o) => {
            const on = picks[q.question]?.includes(o.label) ?? false;
            return (
              <button
                aria-pressed={on}
                className={cn(
                  "grid gap-0.5 rounded-tile border px-3.5 py-2.5 text-left outline-none transition-[background-color,border-color] duration-[var(--motion-control)] ease-[var(--ease-move)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]",
                  on ? "border-contrast bg-accent-soft" : "border-line bg-surface-raised hover:bg-surface-pressed",
                )}
                key={o.label}
                onClick={() => toggle(q, o.label)}
                type="button"
              >
                <span className={cn("text-[0.9375rem] font-medium", on && "text-accent-ink")}>{o.label}</span>
                {o.description ? <span className="text-[0.8125rem] text-ink-muted">{o.description}</span> : null}
              </button>
            );
          })}
        </div>
        <Input className="h-11" onChange={(e) => setOther({ ...other, [q.question]: e.target.value })} placeholder="其他（自己寫）" value={other[q.question] ?? ""} />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Button onClick={() => onAnswer({ decision: "deny", message: "The user declined to answer." })} variant="ghost">略過</Button>
        <Button disabled={step === 0} onClick={() => { setMoved(true); setStep(step - 1); }}>上一題</Button>
        {last ? (
          <Button disabled={!complete} onClick={() => onAnswer({ decision: "allow", answers })} variant="primary">送出</Button>
        ) : (
          <Button disabled={!answers[q.question]} onClick={() => setStep(step + 1)} variant="primary">下一題</Button>
        )}
      </div>
    </>
  );
}
