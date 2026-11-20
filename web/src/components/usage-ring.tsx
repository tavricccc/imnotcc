import { tone } from "@/lib/format";
import { cn } from "@/lib/utils";

// The usage ring: one arc, how full something is. On the list it is the fuller of the plan's
// 5-hour and weekly windows; in a session, the context against its auto-compact threshold.
const R = 13;
const C = 2 * Math.PI * R;
const clamp = (p: number | null) => Math.max(0, Math.min(100, p ?? 0));
const STROKE = { ok: "stroke-contrast", caution: "stroke-caution", danger: "stroke-danger" } as const;

export function UsageRing({ className, label, onClick, pct }: {
  className?: string;
  label: string;
  onClick: () => void;
  pct: number | null;
}) {
  return (
    <button
      aria-label={label}
      className={cn(
        "glass-control relative grid size-11 shrink-0 place-items-center rounded-full border text-ink outline-none transition-[background-color,transform] duration-[var(--motion-control)] ease-[var(--ease-move)] hover:bg-surface-pressed active:scale-[var(--motion-press-scale)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]",
        className,
      )}
      onClick={onClick}
      title={label}
      type="button"
    >
      <svg aria-hidden className="size-6" viewBox="0 0 36 36">
        <g fill="none" transform="rotate(-90 18 18)">
          <circle className="stroke-surface-pressed" cx="18" cy="18" r={R} strokeWidth="5" />
          {pct != null ? (
            <circle className={cn("ring-arc", STROKE[tone(pct)])} cx="18" cy="18" r={R} strokeDasharray={`${(clamp(pct) / 100) * C} ${C}`} strokeLinecap="round" strokeWidth="5" />
          ) : null}
        </g>
      </svg>
    </button>
  );
}
