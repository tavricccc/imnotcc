import * as React from "react";
import { ArrowCounterClockwise, CaretDown, CaretRight, Check, Cpu, ShieldCheck } from "@phosphor-icons/react/ssr";
import { EFFORTS, MODES, modeLabel } from "@/lib/format";
import { shared, type Controls } from "@/lib/store";
import { useStore } from "@/lib/store-core";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { ListGroup } from "@/ui/list";
import { ChoiceRow } from "@/ui/list-controls";
import { AutoHeight, Popover } from "@/ui/popover";
import { Sheet } from "@/ui/sheet";
import { useCompactViewport } from "@/ui/use-compact-viewport";

export function SettingButton({ children, className, ...props }: React.ComponentProps<typeof Button>) {
  return (
    <Button {...props} className={cn("h-8 min-w-0 shrink gap-1 px-1.5 font-normal sm:gap-2 sm:px-2.5", className)} size="sm" variant="ghost">
      {children}<CaretDown aria-hidden className="size-3 max-[359px]:hidden" />
    </Button>
  );
}

type Panel = "permission" | "model";
type Model = Controls["models"][number];
interface ModelOption { value: string; label: string; detail?: string; efforts: string[] | null }

const ALL_EFFORTS = EFFORTS.filter((e) => e.value).map((e) => e.value);

/** "claude-opus-5-5" -> { family: "opus", version: [5, 5] }; null when the id does not read that way. */
function parseModel(id: string | undefined) {
  const m = id?.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/);
  return m ? { family: m[1], version: [Number(m[2]), Number(m[3] ?? 0)] } : null;
}
const newer = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1];

/** Split the models into each family's newest (shown) and the rest (under "more"). */
function arrangeModels(models: Model[], current: string): { main: ModelOption[]; more: ModelOption[] } {
  const option = (m: Model): ModelOption => ({
    value: m.value,
    label: m.displayName || m.value,
    detail: m.description,
    efforts: m.supportsEffort === false || (m.supportedEffortLevels && !m.supportedEffortLevels.length) ? null : m.supportedEffortLevels ?? ALL_EFFORTS,
  });
  const fallback = models.find((m) => m.value === "default");
  const main: ModelOption[] = [{ value: "", label: "預設模型", detail: fallback?.description, efforts: fallback ? option(fallback).efforts : ALL_EFFORTS }];
  const rest = models.filter((m) => m.value !== "default");
  // Newest version per family, from what each entry resolves to.
  const best = new Map<string, number[]>();
  for (const m of rest) {
    const p = parseModel(m.resolvedModel ?? m.value);
    if (p && (!best.has(p.family) || newer(p.version, best.get(p.family)!) > 0)) best.set(p.family, p.version);
  }
  const seen = new Set<string>(); // one entry per resolved model in the main list: "opus" over "claude-opus-5-5"
  const more: ModelOption[] = [];
  for (const m of rest) {
    const resolved = m.resolvedModel ?? m.value;
    const p = parseModel(resolved);
    const latest = !p || newer(p.version, best.get(p.family)!) === 0;
    if (latest && !seen.has(resolved)) { seen.add(resolved); main.push(option(m)); } else if (!latest) more.push(option(m));
  }
  if (current && !main.some((o) => o.value === current) && !more.some((o) => o.value === current)) more.push({ value: current, label: current, efforts: ALL_EFFORTS });
  return { main, more };
}

/** One-line description per level. "" is whatever the computer's own Claude Code settings (modelSettings) say. */
const EFFORT_MOOD: Record<string, { text: string }> = {
  "": { text: "沿用電腦上的全域設定" },
  low: { text: "快速回答，不多想" },
  medium: { text: "剛剛好" },
  high: { text: "認真想一想" },
  xhigh: { text: "全力以赴" },
  max: { text: "火力全開，慢一點也值得" },
};

/** Effort as a slider over what this model offers, "預設" first. Commits when the thumb is let go. */
function EffortSlider({ disabled, effort, levels, onEffort }: { disabled?: boolean; effort: string; levels: string[]; onEffort: (effort: string) => void }) {
  const steps = ["", ...levels];
  const index = Math.max(0, steps.indexOf(effort));
  const [draft, setDraft] = React.useState(index);
  // What was last sent, so a blur right after a release does not send it twice.
  const sent = React.useRef(effort);
  React.useEffect(() => { setDraft(index); sent.current = effort; }, [index, effort]);
  const commit = () => { if (steps[draft] !== sent.current) { sent.current = steps[draft]; onEffort(steps[draft]); } };
  const label = (v: string) => EFFORTS.find((e) => e.value === v)?.label ?? v;
  const mood = EFFORT_MOOD[steps[draft]] ?? { text: label(steps[draft]) };
  const pct = steps.length > 1 ? (draft / (steps.length - 1)) * 100 : 0;
  return (
    <div className="grid gap-1.5 px-1">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">Effort</span>
        <span aria-live="polite" className="effort-pop flex items-center gap-1.5 text-sm" key={draft}>
          <span className="font-semibold text-contrast">{label(steps[draft])}</span>
          <span className="text-ink-muted">· {mood.text}</span>
        </span>
      </div>
      <input
        aria-label="Effort"
        aria-valuetext={`${label(steps[draft])}，${mood.text}`}
        className="effort-range"
        disabled={disabled}
        max={steps.length - 1}
        min={0}
        onBlur={commit}
        onChange={(e) => { setDraft(Number(e.target.value)); navigator.vibrate?.(5); }}
        onKeyUp={(e) => { if (e.key === "Enter") commit(); }}
        onPointerUp={commit}
        step={1}
        style={{ "--pct": pct } as React.CSSProperties}
        type="range"
        value={draft}
      />
      <div aria-hidden className="flex justify-between text-[0.6875rem] text-ink-faint">
        {steps.map((s, i) => <button className={cn("rounded px-0.5 transition-colors", i === draft && "font-semibold text-contrast")} disabled={disabled} key={s || "default"} onClick={() => { setDraft(i); if (sent.current !== s) { sent.current = s; onEffort(s); } }} tabIndex={-1} type="button">{label(s)}</button>)}
      </div>
    </div>
  );
}

/** Desktop: a pill track with a dot per level and a big round thumb. Commits when let go.
    The thumb is drawn here (the native one is invisible, only taking the drag) so it moves with the fill.
    No "default" stop: with no effort set, the thumb rests on medium. */
function EffortPill({ disabled, effort, levels, onEffort }: { disabled?: boolean; effort: string; levels: string[]; onEffort: (effort: string) => void }) {
  const steps = levels;
  const index = steps.indexOf(effort) >= 0 ? steps.indexOf(effort) : Math.max(0, steps.indexOf("medium"));
  const [draft, setDraft] = React.useState(index);
  const sent = React.useRef(effort);
  React.useEffect(() => { setDraft(index); sent.current = effort; }, [index, effort]);
  const pick = (i: number) => { if (steps[i] !== sent.current) { sent.current = steps[i]; onEffort(steps[i]); } };
  const label = (v: string) => EFFORTS.find((e) => e.value === v)?.label ?? v;
  const last = Math.max(1, steps.length - 1);
  const at = (i: number) => `calc(14px + (100% - 28px) * ${i / last})`;
  const move = "duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)]";
  return (
    <div className="relative h-7">
      <div aria-hidden className="absolute inset-0 rounded-full bg-ink/10" />
      <div aria-hidden className={cn("absolute inset-y-0 left-0 rounded-full bg-contrast transition-[width]", move)} style={{ width: `calc(${at(draft)} + 14px)` }} />
      {steps.map((s, i) => (
        <span aria-hidden className={cn("absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors", move, i < draft ? "bg-white/70" : "bg-ink/30")} key={s} style={{ left: at(i) }} />
      ))}
      <input
        aria-label="Effort"
        aria-valuetext={label(steps[draft])}
        className="effort-pill peer absolute inset-0"
        disabled={disabled}
        max={steps.length - 1}
        min={0}
        onBlur={() => pick(draft)}
        onChange={(e) => setDraft(Number(e.target.value))}
        onKeyUp={(e) => { if (e.key === "Enter") pick(draft); }}
        onPointerUp={(e) => pick(Number(e.currentTarget.value))}
        step={1}
        type="range"
        value={draft}
      />
      <span aria-hidden className={cn("pointer-events-none absolute top-1/2 size-6 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_4px_rgb(0_0_0/25%)] transition-[left,box-shadow]", move, "peer-focus-visible:shadow-[0_0_0_4px_var(--focus-ring,rgb(220_58_28/35%))]")} style={{ left: at(draft) }} />
    </div>
  );
}

/** A plain menu row: the model name and a check when chosen. */
function ModelRow({ label, onSelect, selected }: { label: string; onSelect: () => void; selected: boolean }) {
  return (
    <li>
      <button aria-checked={selected} className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-ink/5" onClick={onSelect} role="radio" type="button">
        <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
        <Check aria-hidden className={cn("size-4 shrink-0", selected ? "opacity-100" : "opacity-0")} />
      </button>
    </li>
  );
}

export function ComposerSettings({ disabled, effort, mode, model, onEffort, onMode, onModel }: {
  disabled?: boolean;
  effort: string;
  mode: string;
  model: string;
  onEffort: (effort: string) => void;
  onMode: (mode: string) => void;
  onModel: (model: string) => void;
}) {
  const { controls } = useStore(shared);
  const [panel, setPanel] = React.useState<Panel | null>(null);
  const { main, more } = React.useMemo(() => arrangeModels(controls?.models ?? [], model), [controls, model]);
  const chosen = [...main, ...more].find((m) => m.value === model) ?? main[0];
  const [showMore, setShowMore] = React.useState(false);
  React.useEffect(() => { if (panel === "model") setShowMore(false); }, [panel]);
  const permission = mode === "default" ? "詢問權限" : modeLabel(mode);
  const modelName = model ? chosen.label : "預設模型";
  const effortName = effort ? EFFORTS.find((e) => e.value === effort)?.label ?? effort : "";
  const compact = useCompactViewport();
  const [view, setView] = React.useState<"effort" | "models">("effort");
  const [moreOpen, setMoreOpen] = React.useState(false);
  React.useEffect(() => { if (panel === "model") { setView("effort"); setMoreOpen(false); } }, [panel]);
  const pickRow = (m: ModelOption) => <ModelRow key={m.value} label={m.label} onSelect={() => { onModel(m.value); setMoreOpen(false); setView("effort"); }} selected={model === m.value} />;
  const modelTrigger = (
    <SettingButton aria-label={`模型：${modelName}${effortName ? `，Effort：${effortName}` : ""}`} className="min-w-10 max-[359px]:max-w-24" disabled={disabled}>
      <Cpu className="hidden sm:block" />
      <span className="truncate">
        {model ? modelName : <><span className="sm:hidden">模型</span><span className="hidden sm:inline">預設模型</span></>}
        {effortName ? <span className="text-ink-muted"> · {effortName}</span> : null}
      </span>
    </SettingButton>
  );
  function setting(name: Panel, title: string, trigger: React.ReactElement, content: React.ReactNode) {
    return <Sheet onOpenChange={(open) => setPanel(open ? name : null)} open={panel === name} title={title} trigger={trigger}>{content}</Sheet>;
  }
  const row = (m: ModelOption) => <ChoiceRow detail={m.detail} key={m.value || "default"} label={m.label} onSelect={() => onModel(m.value)} selected={model === m.value} />;

  return (
    <>
      {setting("permission", "權限模式",
        <SettingButton aria-label={`權限模式：${permission}`} className={cn("max-[359px]:shrink-0", mode === "bypassPermissions" && "text-danger hover:text-danger")} disabled={disabled}>
          <ShieldCheck className="hidden sm:block" /><span className="truncate">{permission}</span>
        </SettingButton>,
        <ListGroup label="權限模式" role="radiogroup">
          {MODES.map((m) => <ChoiceRow detail={m.detail} key={m.value} label={m.value === "default" ? "詢問權限" : m.label} onSelect={() => { onMode(m.value); setPanel(null); }} selected={mode === m.value} tone={m.value === "bypassPermissions" ? "danger" : "default"} />)}
        </ListGroup>)}
      <span className="flex-1" />
      {compact ? null : (
        <Popover className="w-72 p-0" onOpenChange={(open) => setPanel(open ? "model" : null)} open={panel === "model"} side="top" trigger={modelTrigger}>
          <AutoHeight>
          {view === "models" ? (
            <div className="max-h-[60svh] overflow-y-auto p-1.5">
              <p className="px-3 pt-1.5 pb-1 text-sm text-ink-muted">選取模型</p>
              <ul role="radiogroup" aria-label="模型">{main.filter((m) => m.value).map((m) => pickRow(m))}</ul>
              {more.length ? (
                <Popover align="end" className="w-60 p-0" onOpenChange={setMoreOpen} open={moreOpen} side="left" trigger={
                  <button aria-expanded={moreOpen} className={cn("flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm text-ink-muted hover:bg-ink/5 hover:text-ink", moreOpen && "bg-ink/5 text-ink")} type="button">
                    更多模型<CaretRight className="size-3" weight="bold" />
                  </button>}>
                  <ul aria-label="更多模型" className="max-h-[60svh] overflow-y-auto p-1.5" role="radiogroup">{more.map((m) => pickRow(m))}</ul>
                </Popover>
              ) : null}
            </div>
          ) : (
            <div className="grid gap-2 p-3">
              <div className="grid grid-cols-[1.75rem_1fr_1.75rem] items-center">
                <span />
                <span aria-live="polite" className="text-center text-sm font-semibold text-contrast">{chosen.efforts ? effortName || (EFFORTS.find((e) => e.value === "medium")?.label ?? "medium") : "—"}</span>
                <button aria-label="Effort 改回預設" className="grid size-7 place-items-center rounded-md text-ink-muted hover:bg-ink/5 hover:text-ink disabled:opacity-40" disabled={!effort || !chosen.efforts} onClick={() => onEffort("")} type="button">
                  <ArrowCounterClockwise className="size-4" />
                </button>
              </div>
              <button className="-mt-2.5 flex items-center gap-1 justify-self-center rounded-md px-2 text-xs text-ink-muted hover:text-ink" onClick={() => setView("models")} type="button">
                {modelName}<CaretRight className="size-3" weight="bold" />
              </button>
              {chosen.efforts ? <EffortPill effort={effort} levels={chosen.efforts} onEffort={onEffort} /> : <p className="text-center text-xs text-ink-muted">這個模型不支援調整 Effort。</p>}
            </div>
          )}
          </AutoHeight>
        </Popover>
      )}
      {compact && setting("model", "模型與 Effort",
        modelTrigger,
        <div className="grid gap-5 pb-2">
          {chosen.efforts ? (
              <EffortSlider effort={effort} levels={chosen.efforts} onEffort={onEffort} />
          ) : <p className="px-1 text-sm text-ink-muted">這個模型不支援調整 Effort。</p>}
          <ListGroup label="模型" role="radiogroup">{main.map(row)}</ListGroup>
          {more.length ? (
            <div className="grid gap-2">
              <button aria-expanded={showMore} className="flex items-center gap-1 justify-self-start rounded-md px-1 text-sm text-ink-muted hover:text-ink" onClick={() => setShowMore((v) => !v)} type="button">
                <CaretRight className={cn("size-3 transition-transform", showMore && "rotate-90")} weight="bold" />更多模型（{more.length}）
              </button>
              {showMore ? <ListGroup label="更多模型" role="radiogroup">{more.map(row)}</ListGroup> : null}
            </div>
          ) : null}
        </div>)}
    </>
  );
}
