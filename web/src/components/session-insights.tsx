// Charts for one session: what fills its context, the plan's windows, and what this run cost.
// The same pieces sit in the phone's usage sheet and in the desktop inspector.
import * as React from "react";
import { tokens, tone } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface ContextUsage { used: number; threshold: number | null; max: number; categories?: { name: string; tokens: number }[] }
export interface PlanWindow { pct: number; resetsAt?: string }
export interface Cost { usd: number; added: number; removed: number }

// Colour follows the category, not its rank: the known names keep their slot whatever else is
// present, and anything new takes the next free one.
const SLOTS = ["Messages", "MCP tools", "System tools", "System prompt", "Skills", "Custom agents", "Memory files"];
const LABELS: Record<string, string> = {
  Messages: "訊息", "MCP tools": "MCP 工具", "System tools": "系統工具", "System prompt": "系統提示",
  Skills: "Skills", "Custom agents": "自訂代理", "Memory files": "記憶檔案",
};
function colours(names: string[]) {
  const out: Record<string, string> = {};
  const used = new Set<number>();
  for (const n of names) { const i = SLOTS.indexOf(n); if (i >= 0) { out[n] = `var(--viz-${i + 1})`; used.add(i); } }
  let next = 0;
  for (const n of names) {
    if (out[n]) continue;
    while (used.has(next) && next < 7) next++;
    out[n] = `var(--viz-${Math.min(next, 7) + 1})`;
    used.add(next);
  }
  return out;
}

const pctText = (n: number) => (n > 0 && n < 0.1 ? "<0.1%" : `${n.toFixed(1)}%`);
const TONE_TEXT = { ok: "text-ink", caution: "text-caution", danger: "text-danger" } as const;

/** A titled block; the inspector and the sheet both stack these. */
export function Section({ action, children, className, title }: { action?: React.ReactNode; children: React.ReactNode; className?: string; title: React.ReactNode }) {
  return (
    <section className={cn("grid gap-3", className)}>
      <div className="flex h-5 items-center justify-between gap-2">
        <h3 className="text-[0.75rem] font-medium uppercase tracking-wide text-ink-faint">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * The context window as one stacked bar, measured against the whole window, with the
 * auto-compact threshold as a tick. Hovering a segment or its row lights both.
 */
export function ContextChart({ context }: { context: ContextUsage | null }) {
  const [hot, setHot] = React.useState<string | null>(null);
  if (!context) {
    return (
      <div className="grid gap-3">
        <div className="h-2.5 rounded-full bg-surface-pressed" />
        <p className="text-[0.8125rem] text-ink-faint">回覆一次之後才有資料</p>
      </div>
    );
  }
  const { used, threshold, max } = context;
  const cats = [...(context.categories ?? [])].sort((a, b) => b.tokens - a.tokens);
  const known = cats.reduce((n, c) => n + c.tokens, 0);
  // Whatever the categories do not account for still counts as used.
  const rest = Math.max(0, used - known);
  const segs = rest > max * 0.002 ? [...cats, { name: "其他", tokens: rest }] : cats;
  const colour = colours(segs.map((c) => c.name));
  colour["其他"] = "var(--ink-faint)";
  // Auto-compact fires at the threshold; past it to the window's end is the buffer it keeps.
  const limit = threshold && threshold < max ? threshold : max;
  const pct = max ? (used / max) * 100 : 0;
  // The colour warns as compaction nears, so it is measured against the threshold.
  const t = tone(limit ? (used / limit) * 100 : 0);
  const mark = Math.min(100, (limit / max) * 100);
  const buffer = max - limit;

  return (
    <div className="grid gap-4">
      <div className="flex items-end justify-between gap-3">
        <div className={cn("text-[2rem] font-semibold leading-none tabular-nums tracking-tight", TONE_TEXT[t])}>
          {Math.round(pct)}<span className="text-[1.125rem] font-medium text-ink-muted">%</span>
        </div>
        <div className="text-right text-[0.8125rem] leading-tight tabular-nums text-ink-muted">
          <span className="text-ink">{tokens(used)}</span> / {tokens(max)}
        </div>
      </div>

      <div className="relative pb-4">
        <div className="flex h-2.5 gap-[2px] overflow-hidden rounded-full bg-surface-pressed" role="img"
          aria-label={`已用 ${tokens(used)}，${tokens(limit)} 時自動壓縮`}>
          {segs.map((c, i) => (
            <div
              className={cn("bar-in h-full shrink-0 transition-opacity duration-[var(--motion-control)]", i === 0 && "rounded-l-full", hot && hot !== c.name && "opacity-30")}
              key={c.name}
              onPointerEnter={() => setHot(c.name)}
              onPointerLeave={() => setHot(null)}
              style={{ width: `${(c.tokens / max) * 100}%`, background: colour[c.name], minWidth: c.tokens ? 2 : 0 }}
              title={`${LABELS[c.name] ?? c.name} ${tokens(c.tokens)}`}
            />
          ))}
        </div>
        {buffer > 0 ? <div aria-hidden className="viz-hatch absolute top-0 h-2.5 rounded-r-full" style={{ left: `calc(${mark}% + 1px)`, right: 0 }} /> : null}
        <div aria-hidden className="absolute top-[-3px] h-[16px] w-[2px] -translate-x-1/2 rounded-full bg-ink" style={{ left: `${mark}%` }} />
        <div aria-hidden className={cn("absolute top-[18px] whitespace-nowrap text-[0.6875rem] tabular-nums text-ink-faint", mark > 80 ? "-translate-x-full" : "-translate-x-1/2")} style={{ left: `${mark}%` }}>
          {tokens(limit)} 壓縮
        </div>
      </div>

      {segs.length ? (
        <ul className="grid">
          {segs.map((c) => (
            <li
              className={cn("-mx-2 flex h-8 items-center gap-2.5 rounded-md px-2 text-[0.875rem] transition-colors duration-[var(--motion-control)]", hot === c.name && "bg-surface-raised")}
              key={c.name}
              onPointerEnter={() => setHot(c.name)}
              onPointerLeave={() => setHot(null)}
            >
              <span aria-hidden className="size-2.5 shrink-0 rounded-[3px]" style={{ background: colour[c.name] }} />
              <span className="min-w-0 flex-1 truncate">{LABELS[c.name] ?? c.name}</span>
              <span className="tabular-nums text-ink-muted">{tokens(c.tokens)}</span>
              <span className="w-12 text-right tabular-nums text-ink-faint">{pctText((c.tokens / max) * 100)}</span>
            </li>
          ))}
          <li className="-mx-2 flex h-8 items-center gap-2.5 px-2 text-[0.875rem] text-ink-muted">
            <span aria-hidden className="size-2.5 shrink-0 rounded-[3px] bg-surface-pressed" />
            <span className="min-w-0 flex-1">可用空間</span>
            <span className="tabular-nums">{tokens(Math.max(0, limit - used))}</span>
            <span className="w-12 text-right tabular-nums text-ink-faint">{pctText(Math.max(0, (limit - used) / max) * 100)}</span>
          </li>
          {buffer > 0 ? (
            <li className="-mx-2 flex h-8 items-center gap-2.5 px-2 text-[0.875rem] text-ink-muted">
              <span aria-hidden className="viz-hatch size-2.5 shrink-0 rounded-[3px]" />
              <span className="min-w-0 flex-1">壓縮緩衝</span>
              <span className="tabular-nums">{tokens(buffer)}</span>
              <span className="w-12 text-right tabular-nums text-ink-faint">{pctText((buffer / max) * 100)}</span>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

const TONE_FILL = { ok: "bg-contrast", caution: "bg-caution", danger: "bg-danger" } as const;

/** When a window resets, as a weekday and clock time: 週六上午3:40. */
function resetAt(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("zh-TW", { weekday: "short", hour: "numeric", minute: "2-digit" }).replace(/\s+/g, "");
}

function Meter({ label, window }: { label: string; window: PlanWindow | null | undefined }) {
  const pct = window ? Math.max(0, Math.min(100, window.pct)) : null;
  const t = pct == null ? "ok" : tone(pct);
  const reset = resetAt(window?.resetsAt);
  return (
    <div className="grid gap-2">
      <div className="flex items-baseline gap-3 text-[0.875rem]">
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {reset ? <span className="shrink-0 text-[0.8125rem] text-ink-faint">{reset} 重設</span> : null}
        <span className={cn("w-10 shrink-0 text-right tabular-nums", pct == null ? "text-ink-faint" : TONE_TEXT[t])}>{pct == null ? "—" : `${Math.round(pct)}%`}</span>
      </div>
      <div aria-hidden className="h-1.5 overflow-hidden rounded-full bg-surface-pressed">
        {pct ? <div className={cn("bar-in h-full rounded-full transition-[width] duration-[var(--motion-reveal)]", TONE_FILL[t])} style={{ width: `${pct}%` }} /> : null}
      </div>
    </div>
  );
}

/** The plan's 5-hour and weekly windows, one thin bar each. */
export function PlanRings({ fiveHour, sevenDay }: { fiveHour?: PlanWindow | null; sevenDay?: PlanWindow | null }) {
  return (
    <div className="grid gap-4">
      <Meter label="5 小時限制" window={fiveHour} />
      <Meter label="每週 · 所有模型" window={sevenDay} />
    </div>
  );
}

/** What this run of the session cost and changed. */
export function RunStats({ cost }: { cost: Cost | null }) {
  const total = cost ? cost.added + cost.removed : 0;
  return (
    <div className="grid grid-cols-2 gap-2">
      <div className="grid gap-1 rounded-tile bg-surface-raised px-3.5 py-3">
        <span className="text-[0.75rem] text-ink-faint">費用</span>
        <span className="text-[1.375rem] font-semibold leading-none tabular-nums">{cost ? `$${cost.usd.toFixed(2)}` : "—"}</span>
      </div>
      <div className="grid gap-1 rounded-tile bg-surface-raised px-3.5 py-3">
        <span className="text-[0.75rem] text-ink-faint">程式碼</span>
        <span className="flex items-baseline gap-2 text-[0.9375rem] font-semibold leading-none tabular-nums">
          {cost ? <>
            <span className="text-[var(--viz-6)]">+{cost.added}</span>
            <span className="text-[var(--viz-8)]">−{cost.removed}</span>
          </> : "—"}
        </span>
        <div aria-hidden className="mt-1 flex h-1.5 gap-[2px] overflow-hidden rounded-full bg-surface-pressed">
          {total ? <>
            <div className="bar-in h-full rounded-l-full bg-[var(--viz-6)]" style={{ width: `${(cost!.added / total) * 100}%` }} />
            <div className="bar-in h-full rounded-r-full bg-[var(--viz-8)]" style={{ width: `${(cost!.removed / total) * 100}%` }} />
          </> : null}
        </div>
      </div>
    </div>
  );
}

