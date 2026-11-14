import * as React from "react";
import { CaretDown, Cpu, ShieldCheck } from "@phosphor-icons/react/ssr";
import { EFFORTS, MODES, modeLabel } from "@/lib/format";
import { shared } from "@/lib/store";
import { useStore } from "@/lib/store-core";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { ListGroup } from "@/ui/list";
import { ChoiceRow } from "@/ui/list-controls";
import { Sheet } from "@/ui/sheet";

export function SettingButton({ children, className, ...props }: React.ComponentProps<typeof Button>) {
  return (
    <Button {...props} className={cn("h-8 min-w-0 shrink gap-1 px-1.5 font-normal sm:gap-2 sm:px-2.5", className)} size="sm" variant="ghost">
      {children}<CaretDown aria-hidden className="size-3 max-[359px]:hidden" />
    </Button>
  );
}

type Panel = "permission" | "model" | "effort";

export function ComposerSettings({ disabled, effort, effortLocked, mode, model, onEffort, onMode, onModel }: {
  disabled?: boolean;
  effort: string;
  /** A turn is running: effort can only change once it ends. */
  effortLocked?: boolean;
  mode: string;
  model: string;
  onEffort: (effort: string) => void;
  onMode: (mode: string) => void;
  onModel: (model: string) => void;
}) {
  const { controls } = useStore(shared);
  const [panel, setPanel] = React.useState<Panel | null>(null);
  const models = controls?.models ?? [];
  const modelOptions = [{ value: "", label: "預設模型" }, ...models.map((m) => ({ value: m.value, label: m.displayName || m.value })),
    ...(model && !models.some((m) => m.value === model) ? [{ value: model, label: model }] : [])];
  const permission = mode === "default" ? "詢問權限" : modeLabel(mode);
  const modelName = modelOptions.find((m) => m.value === model)?.label;
  function setting(name: Panel, title: string, trigger: React.ReactElement, content: React.ReactNode) {
    return <Sheet onOpenChange={(open) => setPanel(open ? name : null)} open={panel === name} title={title} trigger={trigger}>{content}</Sheet>;
  }

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
      {setting("model", "模型",
        <SettingButton aria-label={`模型：${modelName}`} className="min-w-10 max-[359px]:max-w-20" disabled={disabled}>
          <Cpu className="hidden sm:block" />
          <span className="truncate">{model ? modelName : <><span className="sm:hidden">模型</span><span className="hidden sm:inline">預設模型</span></>}</span>
        </SettingButton>,
        <ListGroup label="模型" role="radiogroup">
          {modelOptions.map((m) => <ChoiceRow key={m.value} label={m.label} onSelect={() => { onModel(m.value); setPanel(null); }} selected={model === m.value} />)}
        </ListGroup>)}
      {setting("effort", "Effort",
        <SettingButton aria-label={`Effort：${effort || "預設"}`} className="max-[359px]:shrink-0" disabled={disabled || effortLocked} title={effortLocked ? "這一輪結束後才能改 Effort" : undefined}><span className="truncate">{effort || "Effort"}</span></SettingButton>,
        <ListGroup footer="Claude Code 已開啟時，改 Effort 會重新啟動它，對話會接續。" label="Effort" role="radiogroup">
          {EFFORTS.map((e) => <ChoiceRow key={e.value} label={e.label} onSelect={() => { onEffort(e.value); setPanel(null); }} selected={effort === e.value} />)}
        </ListGroup>)}
    </>
  );
}
