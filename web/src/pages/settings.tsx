import * as React from "react";
import { toast } from "sonner";
import { ArrowsInLineVertical, FileText, Clock, FolderSimple, FolderSimplePlus, Plus, SlidersHorizontal, Trash, X } from "@phosphor-icons/react/ssr";
import { del, post, put } from "@/lib/api";
import { EFFORTS, MODES, WINDOWS, baseName, modeLabel, tokens } from "@/lib/format";
import { shared } from "@/lib/store";
import { useStore } from "@/lib/store-core";
import { Button } from "@/ui/button";
import { ConfirmDialog } from "@/ui/confirm-dialog";
import { Field, Input, Textarea } from "@/ui/field";
import { ListGroup, ListRow } from "@/ui/list";
import { ChoiceRow, NumberRow, PickerRow } from "@/ui/list-controls";
import { readClaudeGlobal, useClaudeGlobal, readCompactWindows, type ClaudeEnv, useCompactWindows, useFolders, useSettings, type Settings } from "@/lib/resources";
import { ErrorState, LoadingList, PageHeader } from "@/ui/page";
import { Sheet } from "@/ui/sheet";

const DEFAULT = "__default";

async function saveSettings(patch: Partial<Settings>) {
  try {
    const r = await put("/api/settings", patch);
    toast.success("已儲存");
    return r.settings as Settings;
  } catch (e) {
    toast.error((e as Error).message);
    return null;
  }
}

// ---- Claude 設定 ----

export function SettingsPage() {
  const s = useSettings();
  const f = useFolders();
  const w = useCompactWindows();
  const [idle, setIdle] = React.useState<number>();
  React.useEffect(() => { if (s.data) setIdle(s.data.idleMinutes); }, [s.data]);
  // Saved once typing pauses, so each keystroke is not its own save.
  React.useEffect(() => {
    const d = s.data;
    if (!d || idle === undefined || !Number.isInteger(idle) || idle < 0 || idle > 1440 || idle === d.idleMinutes) return;
    const timer = setTimeout(() => {
      void saveSettings({ idleMinutes: idle }).then((saved) => saved && s.setData(saved));
    }, 800);
    return () => clearTimeout(timer);
  }, [idle, s.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const st = s.data;
  const fold = f.data;
  const win = w.data;
  const error = s.error || f.error || w.error;
  const retry = () => { void s.reload(); void f.reload(); void w.reload(); };
  const set = win?.windows?.filter((x) => x.window).length ?? 0;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <PageHeader title="Claude 設定" />
      {error ? <ErrorState message={error} onRetry={retry} retryLabel="重試" title="讀不到設定" /> : null}

      {!st && !error ? <LoadingList label="載入中" rows={1} /> : null}
      {st && fold && win ? (
        <ListGroup footer="已經開著的對話用自己的設定，在對話的選項裡改。" title="Claude Code">
          <ListRow detail={`${modeLabel(st.permissionMode)} · ${st.model || "預設模型"}`} href="/settings/defaults" icon={<SlidersHorizontal />} label="新對話的預設值" />
          <ListRow href="/settings/folders" icon={<FolderSimple />} label="資料夾" value={`${fold.length} 個`} />
          <ListRow href="/settings/global" icon={<FileText />} label="全域 CLAUDE.md 與預設 Effort" />
          <ListRow href="/settings/compact" icon={<ArrowsInLineVertical />} label="自動壓縮門檻" value={set ? `${set} 個模型` : "預設"} />
        </ListGroup>
      ) : null}

      {!st && !error ? <LoadingList label="載入中" rows={1} /> : null}
      {st ? (
        <ListGroup footer="關閉後下一則訊息會自動接續。0 表示不關。" title="背景執行">
          <NumberRow
            label="閒置後關閉"
            max={1440}
            min={0}
            onChange={setIdle}
            unit="分鐘"
            value={idle}
          />
        </ListGroup>
      ) : null}
    </div>
  );
}

// ---- 設定 › 新 session 的預設值 ----

export function DefaultsPage() {
  const { controls } = useStore(shared);
  const s = useSettings();
  const f = useFolders();
  const models = controls?.models ?? [];
  const d = s.data && f.data ? { settings: s.data, folders: f.data } : null;
  const error = s.error || f.error;

  async function save(patch: Partial<Settings>) {
    const saved = await saveSettings(patch);
    if (saved) s.setData(saved);
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <PageHeader back={{ href: "/settings", label: "Claude 設定" }} description="開新對話時先用這些，之後可以在對話裡改。" title="新對話的預設值" />
      {error ? <ErrorState message={error} onRetry={() => { void s.reload(); void f.reload(); }} retryLabel="重試" title="讀不到設定" />
        : !d ? <LoadingList label="載入中" rows={2} />
        : (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
            <ListGroup label="權限模式" role="radiogroup" title="權限模式">
              {MODES.map((m) => (
                <ChoiceRow detail={m.detail} key={m.value} label={m.label} onSelect={() => void save({ permissionMode: m.value })} selected={d.settings.permissionMode === m.value} tone={m.value === "bypassPermissions" ? "danger" : "default"} />
              ))}
            </ListGroup>
            <ListGroup footer={models.length ? undefined : "模型清單在第一次對話後出現。"} title="執行">
              <PickerRow
                label="模型"
                onChange={(v) => void save({ model: v === DEFAULT ? "" : v })}
                options={[{ label: "預設", value: DEFAULT }, ...models.map((m) => ({ label: m.displayName || m.value, value: m.value })),
                  ...(d.settings.model && !models.some((m) => m.value === d.settings.model) ? [{ label: d.settings.model, value: d.settings.model }] : [])]}
                value={d.settings.model || DEFAULT}
              />
              <PickerRow label="Effort" onChange={(v) => void save({ effort: v === DEFAULT ? "" : v })} options={EFFORTS.map((e) => ({ label: e.label, value: e.value || DEFAULT }))} value={d.settings.effort || DEFAULT} />
              <PickerRow
                label="資料夾"
                onChange={(v) => void save({ folder: v === DEFAULT ? "" : v })}
                options={[{ label: "第一個", value: DEFAULT }, ...d.folders.map((f) => ({ label: baseName(f), value: f }))]}
                value={d.settings.folder || DEFAULT}
              />
            </ListGroup>
          </div>
        )}
    </div>
  );
}

// ---- 設定 › 資料夾 ----

export function FoldersPage() {
  const res = useFolders();
  const [addOpen, setAddOpen] = React.useState(false);
  const [removing, setRemoving] = React.useState<string | null>(null);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <PageHeader
        actions={<Button aria-label="加入資料夾" onClick={() => setAddOpen(true)} size="icon" variant="primary"><Plus weight="bold" /></Button>}
        back={{ href: "/settings", label: "Claude 設定" }}
        title="資料夾"
      />
      {res.error ? <ErrorState message={res.error} onRetry={res.reload} retryLabel="重試" title="讀不到資料夾" />
        : !res.data ? <LoadingList label="載入中" rows={2} />
        : (
          <ListGroup footer="新對話從這些資料夾裡選。移除只是從清單拿掉，不會刪任何東西。">
            {res.data.map((f) => (
              <ListRow
                detail={f}
                icon={<FolderSimple />}
                key={f}
                label={baseName(f)}
                trailing={<Button aria-label={`移除 ${f}`} onClick={() => setRemoving(f)} size="icon-sm" variant="ghost"><X weight="bold" /></Button>}
              />
            ))}
            <ListRow icon={<FolderSimplePlus />} label="加入資料夾" onClick={() => setAddOpen(true)} />
          </ListGroup>
        )}

      <AddFolderSheet onAdded={(folders) => res.setData(folders)} onOpenChange={setAddOpen} open={addOpen} />
      <ConfirmDialog
        confirmLabel="移除"
        description={removing ?? undefined}
        onConfirm={() => {
          const path = removing;
          setRemoving(null);
          void del("/api/folders", { path }).then((r) => res.setData(r.folders), (e: Error) => toast.error(e.message));
        }}
        onOpenChange={(o) => { if (!o) setRemoving(null); }}
        open={removing !== null}
        title="從清單移除這個資料夾？"
      />
    </div>
  );
}

function AddFolderSheet({ onAdded, onOpenChange, open }: { onAdded: (folders: string[]) => void; onOpenChange: (o: boolean) => void; open: boolean }) {
  const [path, setPath] = React.useState("");
  const [error, setError] = React.useState<string>();
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { if (open) { setPath(""); setError(undefined); } }, [open]);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      onAdded((await post("/api/folders", { path })).folders);
      onOpenChange(false);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Sheet onOpenChange={onOpenChange} open={open} title="加入資料夾">
      <form className="grid gap-4 pb-2" onSubmit={submit}>
        <Field error={error} hint="電腦上的完整路徑，資料夾要已經存在。" label="路徑">
          {({ describedBy, id, invalid }) => (
            <Input aria-describedby={describedBy} aria-invalid={invalid || undefined} autoComplete="off" autoFocus id={id} onChange={(e) => setPath(e.target.value)} placeholder="C:\Users\...\project" spellCheck={false} value={path} />
          )}
        </Field>
        <Button disabled={!path.trim()} size="lg" status={busy ? "loading" : "idle"} type="submit" variant="primary">加入</Button>
      </form>
    </Sheet>
  );
}

// ---- 設定 › 自動壓縮門檻 ----

export function CompactPage() {
  const res = useCompactWindows();
  const [editing, setEditing] = React.useState<{ env: ClaudeEnv; model: string } | null>(null);
  const [newModel, setNewModel] = React.useState<Partial<Record<ClaudeEnv, string>>>({});

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <PageHeader back={{ href: "/settings", label: "Claude 設定" }} description="寫在 Claude Code 的 settings.json，電腦上也一起生效。Windows 和 WSL 各有自己的 settings.json，分開設定。" title="自動壓縮門檻" />
      {res.error ? <ErrorState message={res.error} onRetry={res.reload} retryLabel="重試" title="讀不到門檻" />
        : !res.data ? <LoadingList label="載入中" rows={2} />
        : (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
            {res.data.envs.map((env) => {
              const rows = res.data!.windows.filter((w) => w.env === env);
              const typed = newModel[env] ?? "";
              return (
                <div className="grid grid-cols-[minmax(0,1fr)] gap-3" key={env}>
                  <ListGroup footer={env === "wsl" ? "WSL 裡的 ~/.claude/settings.json，WSL 對話使用。" : "Windows 的 ~/.claude/settings.json，Windows 對話使用。"} title={ENV_LABEL[env]}>
                    {rows.length ? rows.map((w) => (
                      <ListRow icon={<Clock />} key={w.model} label={w.model} onClick={() => setEditing({ env, model: w.model })} value={w.window ? tokens(w.window) : "預設"} />
                    )) : <ListRow icon={<Clock />} label="還沒有設定過的模型" />}
                  </ListGroup>
                  <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) setEditing({ env, model: typed.trim() }); }}>
                    <Field hint={`清單裡沒有的模型，打它的名稱來設定 ${ENV_LABEL[env]} 的門檻。`} label="其他模型">
                      {({ describedBy, id }) => <Input aria-describedby={describedBy} id={id} onChange={(e) => setNewModel((m) => ({ ...m, [env]: e.target.value }))} placeholder="例如 claude-haiku-5-5" spellCheck={false} value={typed} />}
                    </Field>
                    <Button className="justify-self-end" disabled={!typed.trim()} type="submit">設定</Button>
                  </form>
                </div>
              );
            })}
          </div>
        )}

      <ModelWindowSheet
        current={res.data?.windows.find((w) => w.env === editing?.env && w.model === editing?.model)?.window}
        env={editing?.env ?? "win"}
        model={editing?.model ?? null}
        onDone={async () => { const env = editing?.env; res.setData(await readCompactWindows()); if (env) setNewModel((m) => ({ ...m, [env]: "" })); }}
        onOpenChange={(o) => { if (!o) setEditing(null); }}
      />
    </div>
  );
}

const ENV_LABEL: Record<ClaudeEnv, string> = { win: "Windows", wsl: "WSL" };

function ModelWindowSheet({ current, env, model, onDone, onOpenChange }: { current?: number; env: ClaudeEnv; model: string | null; onDone: () => Promise<void>; onOpenChange: (o: boolean) => void }) {
  const [custom, setCustom] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [reply, setReply] = React.useState("");
  const shown = React.useRef(model);
  if (model) shown.current = model;
  React.useEffect(() => { if (model) { setCustom(""); setReply(""); } }, [model]);

  async function apply(size: string) {
    setBusy(size);
    setReply("");
    try {
      const r = await post("/api/compact-windows", { env, model, size });
      setReply(r.reply);
      await onDone();
    } catch (e) { setReply((e as Error).message); } finally { setBusy(null); }
  }

  const currentLabel = current ? tokens(current) : null;
  return (
    <Sheet description="在背景執行 /autocompact，要等幾秒。" onOpenChange={onOpenChange} open={model !== null} title={shown.current ? `${shown.current}（${ENV_LABEL[env]}）` : ""}>
      <div className="grid gap-5 pb-2">
        <ListGroup label="門檻" role="radiogroup">
          {WINDOWS.map((w) => (
            <ChoiceRow disabled={busy !== null} key={w.value} label={busy === w.value ? `${w.label}（套用中…）` : w.label} onSelect={() => void apply(w.value)} selected={currentLabel === w.label} />
          ))}
        </ListGroup>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (custom.trim()) void apply(custom.trim()); }}>
          <Input aria-label="自訂門檻" className="h-11" disabled={busy !== null} onChange={(e) => setCustom(e.target.value)} placeholder="自訂，例如 350k" value={custom} />
          <Button disabled={busy !== null || !custom.trim()} status={busy === custom.trim() && busy ? "loading" : "idle"} type="submit">套用</Button>
        </form>
        {reply ? <p className="message-in whitespace-pre-wrap px-1 text-sm text-ink-muted" role="status">{reply}</p> : null}
      </div>
    </Sheet>
  );
}


// ---- 設定 › 全域 CLAUDE.md 與預設 Effort ----

const LEVELS = EFFORTS.filter((e) => e.value);

function GlobalEnv({ env, md, efforts, onSaved }: { env: ClaudeEnv; md: string; efforts: { model: string; effort: string | null }[]; onSaved: () => Promise<void> }) {
  const [text, setText] = React.useState(md);
  const [busy, setBusy] = React.useState(false);
  const [model, setModel] = React.useState("");
  React.useEffect(() => setText(md), [md]);
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try { await fn(); toast.success("已儲存"); await onSaved(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  const setEffort = (m: string, effort: string) => run(() => put("/api/default-effort", { env, model: m, effort }));
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <ListGroup footer={env === "wsl" ? "WSL 的 ~/.claude/settings.json。" : "Windows 的 ~/.claude/settings.json。"} title={`${ENV_LABEL[env]} 預設 Effort`}>
        {efforts.length ? efforts.map((x) => (
          <PickerRow disabled={busy} key={x.model} label={x.model} onChange={(v) => void setEffort(x.model, v === DEFAULT ? "" : v)} options={[{ value: DEFAULT, label: "不指定" }, ...LEVELS]} value={x.effort ?? DEFAULT} />
        )) : <ListRow label="還沒有設定過的模型" />}
      </ListGroup>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (model.trim()) void setEffort(model.trim(), "medium").then(() => setModel("")); }}>
        <Input aria-label="其他模型" className="h-11" disabled={busy} onChange={(e) => setModel(e.target.value)} placeholder="其他模型，例如 claude-haiku-5-5" spellCheck={false} value={model} />
        <Button disabled={busy || !model.trim()} type="submit">加入</Button>
      </form>
      <Field hint={`${ENV_LABEL[env]} 的 ~/.claude/CLAUDE.md，這個環境的所有對話都會讀到。`} label={`${ENV_LABEL[env]} 全域 CLAUDE.md`}>
        {({ describedBy, id }) => <Textarea aria-describedby={describedBy} className="min-h-48 font-mono text-sm" id={id} onChange={(e) => setText(e.target.value)} spellCheck={false} value={text} />}
      </Field>
      <Button className="justify-self-end" disabled={busy || text === md} onClick={() => void run(() => put("/api/claude-md", { env, text }))}>儲存 CLAUDE.md</Button>
    </div>
  );
}

export function GlobalPage() {
  const res = useClaudeGlobal();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-8">
      <PageHeader back={{ href: "/settings", label: "Claude 設定" }} description="直接改電腦上的檔案。Windows 和 WSL 各有自己的一份，分開設定。已經開著的對話要重開才會套用。" title="全域 CLAUDE.md 與預設 Effort" />
      {res.error ? <ErrorState message={res.error} onRetry={res.reload} retryLabel="重試" title="讀不到設定" />
        : !res.data ? <LoadingList label="載入中" rows={2} />
        : res.data.envs.map((env) => (
          <GlobalEnv efforts={res.data!.efforts.filter((x) => x.env === env)} env={env} key={env} md={res.data!.claudeMd[env] ?? ""} onSaved={async () => res.setData(await readClaudeGlobal())} />
        ))}
    </div>
  );
}
