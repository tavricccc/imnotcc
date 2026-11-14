import * as React from "react";
import { toast } from "sonner";
import { ArrowsInLineVertical, Clock, FolderSimple, FolderSimplePlus, Key, Plus, SignOut, SlidersHorizontal, Trash, X } from "@phosphor-icons/react/ssr";
import { auth, del, get, post, put } from "@/lib/api";
import { clearCache } from "@/lib/cache";
import { EFFORTS, MODES, WINDOWS, baseName, modeLabel, tokens } from "@/lib/format";
import { removeLocalTranscripts } from "@/lib/local-transcript";
import { shared } from "@/lib/store";
import { useStore } from "@/lib/store-core";
import { Button } from "@/ui/button";
import { ConfirmDialog } from "@/ui/confirm-dialog";
import { Field, Input } from "@/ui/field";
import { ListGroup, ListRow } from "@/ui/list";
import { ChoiceRow, NumberRow, PickerRow, SwitchRow } from "@/ui/list-controls";
import { prefs, SESSION_LIMITS } from "@/lib/prefs";
import { readSessions, useCompactWindows, useFolders, useSettings, type Settings } from "@/lib/resources";
import { ErrorState, LoadingList, PageHeader } from "@/ui/page";
import { Sheet } from "@/ui/sheet";

const DEFAULT = "__default";
const sessionLimitOptions = SESSION_LIMITS.map((value) => ({ value, label: value === "all" ? "不限" : `${value} 個` }));

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

// ---- 設定 ----

export function SettingsPage() {
  const s = useSettings();
  const f = useFolders();
  const w = useCompactWindows();
  const [idle, setIdle] = React.useState<number>();
  const [passwordOpen, setPasswordOpen] = React.useState(false);
  const [logoutOpen, setLogoutOpen] = React.useState(false);
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

  const view = useStore(prefs);
  const st = s.data;
  const fold = f.data;
  const win = w.data;
  const error = s.error || f.error || w.error;
  const retry = () => { void s.reload(); void f.reload(); void w.reload(); };
  // A failed read still leaves the device settings usable, so only the server's own groups stop.
  const set = win?.filter((x) => x.window).length ?? 0;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <PageHeader title="設定" />
      {error ? <ErrorState message={error} onRetry={retry} retryLabel="重試" title="讀不到設定" /> : null}

      {!st && !error ? <LoadingList label="載入中" rows={1} /> : null}
      {st && fold && win ? (
        <ListGroup footer="已經開著的 session 用自己的設定，在 session 的選項裡改。" title="Claude Code">
          <ListRow detail={`${modeLabel(st.permissionMode)} · ${st.model || "預設模型"}`} href="/settings/defaults" icon={<SlidersHorizontal />} label="新 session 的預設值" />
          <ListRow href="/settings/folders" icon={<FolderSimple />} label="資料夾" value={`${fold.length} 個`} />
          <ListRow href="/settings/compact" icon={<ArrowsInLineVertical />} label="自動壓縮門檻" value={set ? `${set} 個模型` : "預設"} />
        </ListGroup>
      ) : null}

      <ListGroup footer="只存在這個裝置上。" title="對話顯示">
        <SwitchRow checked={view.groupTools} detail="每個回合的工作過程收成「處理了幾分鐘」，只留最後的回覆和改過的檔案" label="折疊工作過程" onChange={(v) => prefs.set({ groupTools: v })} />
        <SwitchRow checked={view.bubbles} label="回覆用對話氣泡" onChange={(v) => prefs.set({ bubbles: v })} />
        <SwitchRow checked={view.hideWork} detail="只留你和 Claude 的對話，執行中會顯示正在用的工具" disabled={!view.bubbles} label="氣泡模式隱藏思考和工具" onChange={(v) => prefs.set({ hideWork: v })} />
      </ListGroup>

      <ProjectSessionsSettings limit={view.projectSessionLimit} />

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

      <ListGroup title="帳號">
        <ListRow icon={<Key />} label="更改密碼" onClick={() => setPasswordOpen(true)} />
        <ListRow icon={<SignOut />} label="登出" onClick={() => setLogoutOpen(true)} tone="danger" />
      </ListGroup>

      <PasswordSheet onOpenChange={setPasswordOpen} open={passwordOpen} />
      <ConfirmDialog
        confirmLabel="登出"
        description="這個裝置要再輸入密碼才能進來。"
        onConfirm={() => void post("/api/logout").then(() => auth.set({ authed: false }))}
        onOpenChange={setLogoutOpen}
        open={logoutOpen}
        title="登出？"
        tone="danger"
      />
    </div>
  );
}

function ProjectSessionsSettings({ limit }: { limit: typeof SESSION_LIMITS[number] }) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  async function clean() {
    setBusy(true);
    try {
      const { groups } = await readSessions();
      const older = groups.flatMap(({ sessions }) => sessions.slice(Number(limit)));
      await removeLocalTranscripts(older.map(({ id }) => id));
      for (const { id } of older) clearCache(`/api/sessions/${id}`);
      setOpen(false);
      toast.success(older.length ? "已清理舊 session 的本機快取" : "沒有超過保留數量的 session");
    } catch {
      toast.error("無法清理本機快取，請再試一次。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ListGroup footer="依最後更新時間顯示。設定保留數量後，可清理超出數量的本機快取。" title="專案 Session">
        <PickerRow label="每個專案保留最新" onChange={(projectSessionLimit) => prefs.set({ projectSessionLimit })} options={sessionLimitOptions} value={limit} />
        <ListRow disabled={limit === "all" || busy} icon={<Trash />} label="清理舊 session 的本機快取" onClick={() => setOpen(true)} />
      </ListGroup>
      <ConfirmDialog
        confirmLabel="清理"
        description={`每個專案會保留最新 ${limit} 個 session 的本機快取。伺服器上的 session 與對話記錄會保留。`}
        onConfirm={() => void clean()}
        onOpenChange={setOpen}
        open={open}
        status={busy ? "loading" : "idle"}
        title="清理舊 session 的本機快取？"
        tone="danger"
      />
    </>
  );
}

function PasswordSheet({ onOpenChange, open }: { onOpenChange: (o: boolean) => void; open: boolean }) {
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [error, setError] = React.useState<string>();
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { if (open) { setCurrent(""); setNext(""); setError(undefined); } }, [open]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await post("/api/password", { current, next });
      onOpenChange(false);
      toast.success("已更新密碼，其他裝置要重新登入");
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Sheet description="改完之後，其他裝置都要重新登入。" onOpenChange={onOpenChange} open={open} title="更改密碼">
      <form className="grid gap-4 pb-2" onSubmit={submit}>
        <Field label="目前的密碼">
          {({ id }) => <Input autoComplete="current-password" id={id} onChange={(e) => setCurrent(e.target.value)} type="password" value={current} />}
        </Field>
        <Field error={error} hint="至少 8 個字元" label="新密碼">
          {({ describedBy, id, invalid }) => (
            <Input aria-describedby={describedBy} aria-invalid={invalid || undefined} autoComplete="new-password" id={id} onChange={(e) => setNext(e.target.value)} type="password" value={next} />
          )}
        </Field>
        <Button disabled={!current || next.length < 8} size="lg" status={busy ? "loading" : "idle"} type="submit" variant="primary">更改密碼</Button>
      </form>
    </Sheet>
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
      <PageHeader back={{ href: "/settings", label: "設定" }} description="開新 session 時先用這些，之後可以在 session 裡改。" title="新 session 的預設值" />
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
        back={{ href: "/settings", label: "設定" }}
        title="資料夾"
      />
      {res.error ? <ErrorState message={res.error} onRetry={res.reload} retryLabel="重試" title="讀不到資料夾" />
        : !res.data ? <LoadingList label="載入中" rows={2} />
        : (
          <ListGroup footer="新 session 從這些資料夾裡選。移除只是從清單拿掉，不會刪任何東西。">
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
  const [editing, setEditing] = React.useState<string | null>(null);
  const [newModel, setNewModel] = React.useState("");

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <PageHeader back={{ href: "/settings", label: "設定" }} description="寫在 Claude Code 的 settings.json，電腦上也一起生效。" title="自動壓縮門檻" />
      {res.error ? <ErrorState message={res.error} onRetry={res.reload} retryLabel="重試" title="讀不到門檻" />
        : !res.data ? <LoadingList label="載入中" rows={2} />
        : (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
            <ListGroup title="模型">
              {res.data.map((w) => (
                <ListRow icon={<Clock />} key={w.model} label={w.model} onClick={() => setEditing(w.model)} value={w.window ? tokens(w.window) : "預設"} />
              ))}
            </ListGroup>
            <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); if (newModel.trim()) setEditing(newModel.trim()); }}>
              <Field hint="清單裡沒有的模型，打它的名稱來設定。" label="其他模型">
                {({ describedBy, id }) => <Input aria-describedby={describedBy} id={id} onChange={(e) => setNewModel(e.target.value)} placeholder="例如 claude-haiku-5-5" spellCheck={false} value={newModel} />}
              </Field>
              <Button className="justify-self-end" disabled={!newModel.trim()} type="submit">設定</Button>
            </form>
          </div>
        )}

      <ModelWindowSheet
        current={res.data?.find((w) => w.model === editing)?.window}
        model={editing}
        onDone={async () => { res.setData((await get("/api/compact-windows")).windows); setNewModel(""); }}
        onOpenChange={(o) => { if (!o) setEditing(null); }}
      />
    </div>
  );
}

function ModelWindowSheet({ current, model, onDone, onOpenChange }: { current?: number; model: string | null; onDone: () => Promise<void>; onOpenChange: (o: boolean) => void }) {
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
      const r = await post("/api/compact-windows", { model, size });
      setReply(r.reply);
      await onDone();
    } catch (e) { setReply((e as Error).message); } finally { setBusy(null); }
  }

  const currentLabel = current ? tokens(current) : null;
  return (
    <Sheet description="在背景執行 /autocompact，要等幾秒。" onOpenChange={onOpenChange} open={model !== null} title={shown.current ?? ""}>
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
