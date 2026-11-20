import * as React from "react";
import { toast } from "sonner";
import { ArrowsClockwise, Check, Desktop, DotsThree, FolderOpen, Globe, Key, Laptop, Link, Package, SignOut, Trash } from "@phosphor-icons/react/ssr";
import { auth, get, post } from "@/lib/api";
import { claudeAuth, refreshClaudeAuth, TARGET_LABEL, type ClaudeTarget } from "@/lib/claude-auth";
import { ClaudeLoginSheet } from "@/components/claude-login";
import { clearCache } from "@/lib/cache";
import { clearLocalTranscripts, localArchiveStats, removeLocalTranscripts } from "@/lib/local-transcript";
import { prefs, SESSION_LIMITS } from "@/lib/prefs";
import { disablePush, enablePush, push, refreshPush, testPush, type PushState } from "@/lib/push";
import { readSessions } from "@/lib/resources";
import { useStore } from "@/lib/store-core";
import { isTauri, remoteLabel, tauriInvoke, tauriListen, type DesktopConfig, type DesktopRemote, type DesktopState } from "@/lib/tauri";
import { Button } from "@/ui/button";
import { ConfirmDialog } from "@/ui/confirm-dialog";
import { Field, Input, Textarea } from "@/ui/field";
import { ListGroup, ListRow } from "@/ui/list";
import { PickerRow, SwitchRow } from "@/ui/list-controls";
import { PageHeader } from "@/ui/page";
import { Sheet } from "@/ui/sheet";

const sessionLimitOptions = SESSION_LIMITS.map((value) => ({ value, label: value === "all" ? "不限" : `${value} 個` }));

const PUSH_DETAIL: Record<PushState, string> = {
  "unsupported": "這個瀏覽器不支援推播通知",
  "needs-install": "iPhone 要先「加入主畫面」，從主畫面打開才能開啟通知",
  "denied": "通知被瀏覽器封鎖了，到系統或瀏覽器設定裡允許",
  "off": "回合完成、需要你確認或發生錯誤時通知你",
  "on": "回合完成、需要你確認或發生錯誤時通知你",
};

function NotificationSettings() {
  const { state } = useStore(push);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { void refreshPush(); }, []);
  const toggle = async (on: boolean) => {
    setBusy(true);
    try { await (on ? enablePush() : disablePush()); }
    catch (e) { toast.error(`通知設定失敗：${(e as Error).message}`); }
    finally { setBusy(false); }
  };
  if (!state) return null;
  return (
    <ListGroup title="通知">
      <SwitchRow checked={state === "on"} detail={PUSH_DETAIL[state]} disabled={busy || (state !== "on" && state !== "off")} label="推播通知" onChange={(on) => void toggle(on)} />
      {state === "on" ? <ListRow label="傳送測試通知" onClick={() => void testPush().catch((e) => toast.error((e as Error).message))} /> : null}
    </ListGroup>
  );
}

const mbText = (bytes: number) => (bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`);
type StorageAction = "all" | "old" | "swcache" | "drafts";

/** What this device keeps for the app, and ways to empty each part. Server data is never touched. */
function LocalStorageSettings() {
  const [stats, setStats] = React.useState<{ bytes: number; count: number; old: string[] } | null>(null);
  const [action, setAction] = React.useState<StorageAction | null>(null);
  const [busy, setBusy] = React.useState(false);
  const refresh = React.useCallback(async () => {
    try {
      const s = await localArchiveStats();
      const cutoff = Date.now() - 30 * 86400_000;
      setStats({ bytes: s.bytes, count: s.sessions.length, old: s.sessions.filter((x) => x.lastAt && x.lastAt < cutoff).map((x) => x.id) });
    } catch { setStats(null); }
  }, []);
  React.useEffect(() => { void refresh(); }, [refresh]);

  const draftKeys = () => Object.keys(localStorage).filter((k) => k.startsWith("imnotcc:composer:"));
  async function run() {
    if (!action) return;
    setBusy(true);
    try {
      if (action === "all") { await clearLocalTranscripts(); clearCache("sessions"); clearCache("/api/sessions"); }
      else if (action === "old") { await removeLocalTranscripts(stats?.old ?? []); }
      else if (action === "swcache") { await Promise.all((await caches.keys()).map((k) => caches.delete(k))); }
      else draftKeys().forEach((k) => localStorage.removeItem(k));
      toast.success("已清理");
      setAction(null);
      await refresh();
    } catch { toast.error("清理失敗，請再試一次。"); } finally { setBusy(false); }
  }
  const text: Record<StorageAction, { title: string; description: string }> = {
    all: { title: "清除全部對話快取？", description: "這個裝置上的所有本機對話快取會刪掉，再打開對話時從伺服器重新載入。" },
    old: { title: "清除 30 天前的對話快取？", description: `會刪掉 ${stats?.old.length ?? 0} 個 30 天沒有動靜的對話的本機快取。` },
    swcache: { title: "清除離線檔案快取？", description: "App 的離線頁面與靜態檔，下次連線會自動重新下載。" },
    drafts: { title: "清除輸入草稿？", description: "各對話還沒送出的輸入文字會刪掉。" },
  };
  return (
    <>
      <ListGroup footer="只影響這個裝置，伺服器上的對話不會動。" title="本機儲存空間">
        <ListRow detail={stats ? `${stats.count} 個對話` : undefined} label="對話快取用量" value={stats ? mbText(stats.bytes) : "計算中"} />
        <ListRow disabled={!stats?.old.length} icon={<Trash />} label="清除 30 天前的對話快取" onClick={() => setAction("old")} />
        <ListRow disabled={!stats?.count} icon={<Trash />} label="清除全部對話快取" onClick={() => setAction("all")} />
        <ListRow icon={<Trash />} label="清除離線檔案快取" onClick={() => setAction("swcache")} />
        <ListRow icon={<Trash />} label="清除輸入草稿" onClick={() => setAction("drafts")} />
      </ListGroup>
      <ConfirmDialog
        confirmLabel="清除"
        description={action ? text[action].description : ""}
        onConfirm={() => void run()}
        onOpenChange={(o) => { if (!o) setAction(null); }}
        open={action !== null}
        status={busy ? "loading" : "idle"}
        title={action ? text[action].title : ""}
        tone="danger"
      />
    </>
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
      toast.success(older.length ? "已清理舊對話的本機快取" : "沒有超過保留數量的對話");
    } catch {
      toast.error("無法清理本機快取，請再試一次。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ListGroup title="專案對話">
        <PickerRow label="每個專案保留最新" onChange={(projectSessionLimit) => prefs.set({ projectSessionLimit })} options={sessionLimitOptions} value={limit} />
        <ListRow disabled={limit === "all" || busy} icon={<Trash />} label="清理舊對話的本機快取" onClick={() => setOpen(true)} />
      </ListGroup>
      <ConfirmDialog
        confirmLabel="清理"
        description={`每個專案會保留最新 ${limit} 個對話的本機快取。伺服器上的對話與對話記錄會保留。`}
        onConfirm={() => void clean()}
        onOpenChange={setOpen}
        open={open}
        status={busy ? "loading" : "idle"}
        title="清理舊對話的本機快取？"
        tone="danger"
      />
    </>
  );
}

function PasswordSheet({ onChanged, onOpenChange, open }: { onChanged?: () => void; onOpenChange: (o: boolean) => void; open: boolean }) {
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
      onChanged?.();
      toast.success("已更新密碼，其他裝置要重新登入");
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Sheet description="其他裝置需要重新登入。" onOpenChange={onOpenChange} open={open} title="更改密碼">
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

interface SdkInfo {
  current: string | null;
  declared: string | null;
  latest: string | null;
  updateAvailable: boolean;
  checkError?: string;
}

function AgentSdkSettings({
  canUpdateLocally,
  onStartUpdate,
  reloadKey,
}: {
  canUpdateLocally: boolean;
  onStartUpdate?: () => void;
  reloadKey: number;
}) {
  const [sdk, setSdk] = React.useState<SdkInfo | null>(null);
  const [checking, setChecking] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    void get("/api/sdk")
      .then((res) => { if (active) setSdk(res as SdkInfo); })
      .catch(() => { if (active) setSdk(null); });
    return () => { active = false; };
  }, [reloadKey]);

  const checkUpdate = async () => {
    setChecking(true);
    try {
      const res = await get("/api/sdk?check=1") as SdkInfo;
      setSdk(res);
      if (res.checkError) {
        toast.error(`檢查失敗：${res.checkError}`);
      } else if (res.updateAvailable && res.latest) {
        toast.info(`發現新版 Agent SDK：v${res.latest}`);
      } else {
        toast.success(`Claude Agent SDK 已是最新（v${res.current ?? "未知"}）`);
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setChecking(false);
    }
  };

  if (!sdk) return null;

  const detail = sdk.checkError
    ? `目前 v${sdk.current ?? "未知"} · 檢查失敗：${sdk.checkError}`
    : sdk.updateAvailable && sdk.latest
      ? (canUpdateLocally
        ? `目前 v${sdk.current ?? "未知"} → 可更新至 v${sdk.latest}`
        : `目前 v${sdk.current ?? "未知"} → 最新 v${sdk.latest}（點擊複製更新指令）`)
      : sdk.latest
        ? `已是最新版本 v${sdk.current ?? sdk.latest}`
        : `目前版本 v${sdk.current ?? "未知"}`;

  const handleRowClick = () => {
    if (checking) return;
    if (sdk.updateAvailable && sdk.latest) {
      if (canUpdateLocally && onStartUpdate) {
        onStartUpdate();
      } else {
        void navigator.clipboard.writeText("npm install @anthropic-ai/claude-agent-sdk@latest")
          .then(() => toast.success("已複製更新指令，請在 Server 電腦執行並重啟 Server"))
          .catch(() => toast.info("請在 Server 電腦執行：npm install @anthropic-ai/claude-agent-sdk@latest"));
      }
      return;
    }
    void checkUpdate();
  };

  return (
    <ListGroup title="Claude Agent SDK">
      <ListRow
        detail={detail}
        disabled={checking}
        icon={<Package />}
        label={checking ? "檢查更新中…" : sdk.updateAvailable && sdk.latest ? (canUpdateLocally ? `更新 Agent SDK 至 v${sdk.latest}` : `有新版本 v${sdk.latest}`) : "檢查 Agent SDK 更新"}
        onClick={handleRowClick}
        value={sdk.current ? `v${sdk.current}` : undefined}
      />
      {sdk.updateAvailable ? (
        <ListRow
          disabled={checking}
          icon={<ArrowsClockwise />}
          label="重新檢查版本"
          onClick={() => void checkUpdate()}
        />
      ) : null}
    </ListGroup>
  );
}

/**
 * The servers this app has connected to, to switch between (also in the tray menu). Switching
 * opens the other server in this window, so this page goes away with it.
 */
function ServerList({ onChanged, st }: { onChanged: (config: DesktopConfig) => void; st: DesktopState }) {
  const remotes = st.config.remotes ?? [];
  const [busy, setBusy] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<DesktopRemote | null>(null);
  const [name, setName] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const hasLocal = !!st.config.installed_version;
  if (!remotes.length && !hasLocal) return null;
  const isCurrent = (url: string) => !st.config.local && st.config.url === url;

  const switchTo = async (key: string, run: () => Promise<unknown>) => {
    setBusy(key);
    try { await run(); } catch (e) { if (String(e) !== "已取消") toast.error(String(e)); } finally { setBusy(null); }
  };
  const saveName = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setSaving(true);
    try { onChanged(await tauriInvoke<DesktopConfig>("rename_remote", { url: editing.url, name })); setEditing(null); }
    catch (err) { toast.error(String(err)); } finally { setSaving(false); }
  };
  const forget = async () => {
    if (!editing) return;
    setSaving(true);
    try { onChanged(await tauriInvoke<DesktopConfig>("forget_remote", { url: editing.url })); setEditing(null); toast.success("已從清單移除"); }
    catch (err) { if (String(err) !== "已取消") toast.error(String(err)); } finally { setSaving(false); }
  };
  const current = <span className="flex shrink-0 items-center gap-1 text-[0.8125rem] text-accent-ink"><Check weight="bold" />使用中</span>;
  const switchButton = (key: string, run: () => Promise<unknown>) => (
    <Button onClick={() => void switchTo(key, run)} size="sm" status={busy === key ? "loading" : "idle"} variant="secondary">切換</Button>
  );

  return (
    <>
      <ListGroup title="Server 清單">
        {hasLocal ? (
          <ListRow detail={st.local_url} icon={<Desktop />} label="本機 Server"
            trailing={st.config.local ? current : switchButton("local", () => tauriInvoke("use_local"))} />
        ) : null}
        {remotes.map((r) => (
          <ListRow detail={r.url} icon={<Globe />} key={r.url} label={remoteLabel(r)}
            trailing={(
              <span className="flex shrink-0 items-center gap-1">
                {isCurrent(r.url) ? current : switchButton(r.url, () => tauriInvoke("use_remote", { url: r.url }))}
                <Button aria-label={`管理 ${remoteLabel(r)}`} onClick={() => { setEditing(r); setName(r.name ?? ""); }} size="icon-sm" title="改名或移除" variant="ghost"><DotsThree weight="bold" /></Button>
              </span>
            )} />
        ))}
      </ListGroup>
      <Sheet description={editing?.url} onOpenChange={(o) => { if (!o) setEditing(null); }} open={!!editing} title={editing ? remoteLabel(editing) : ""}>
        <form className="grid gap-4 pb-2" onSubmit={saveName}>
          <Field hint="留白就顯示網址的主機名稱" label="名稱">
            {({ describedBy, id }) => <Input aria-describedby={describedBy} id={id} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder={editing ? remoteLabel({ url: editing.url }) : ""} value={name} />}
          </Field>
          <Button size="lg" status={saving ? "loading" : "idle"} type="submit" variant="primary">儲存</Button>
          {editing && !isCurrent(editing.url) ? (
            <Button disabled={saving} onClick={() => void forget()} size="lg" type="button" variant="ghost"><Trash />從清單移除</Button>
          ) : null}
        </form>
      </Sheet>
    </>
  );
}

function DesktopSettings({
  onLocalChange,
  onSdkUpdated,
  reloadKey,
  registerSdkUpdate,
}: {
  onLocalChange: (isLocal: boolean) => void;
  onSdkUpdated: () => void;
  reloadKey: number;
  registerSdkUpdate: (fn: (() => void) | undefined) => void;
}) {
  const [st, setSt] = React.useState<DesktopState | null>(null);
  const [err, setErr] = React.useState<string>();
  const [remoteOpen, setRemoteOpen] = React.useState(false);
  const [remoteUrl, setRemoteUrl] = React.useState("");
  const [remoteBusy, setRemoteBusy] = React.useState(false);
  const [remoteErr, setRemoteErr] = React.useState<string>();

  const [hostOpen, setHostOpen] = React.useState(false);
  const [port, setPort] = React.useState("4280");
  const [origins, setOrigins] = React.useState("");
  const [hostBusy, setHostBusy] = React.useState(false);

  const [installOpen, setInstallOpen] = React.useState(false);
  const [installTitle, setInstallTitle] = React.useState("安裝本機 Server");
  const [installDesc, setInstallDesc] = React.useState("會使用本機 Node.js 下載並安裝 server 所需套件。");
  const [installLogs, setInstallLogs] = React.useState("");
  const [installErr, setInstallErr] = React.useState<string>();
  const [installing, setInstalling] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const next = await tauriInvoke<DesktopState>("get_state");
      setSt(next);
      onLocalChange(next.config.local);
      setErr(undefined);
      setPort(String(next.config.port || 4280));
      setOrigins((next.config.origins || []).join("\n"));
      const savedRemote = next.config.remote_url || (!next.config.local ? next.config.url : null);
      if (savedRemote) setRemoteUrl(savedRemote);
    } catch (e) {
      onLocalChange(false);
      setErr(String(e));
    }
  }, [onLocalChange]);

  React.useEffect(() => {
    void load();
  }, [load, reloadKey]);

  React.useEffect(() => {
    let unlog: (() => void) | undefined;
    let undone: (() => void) | undefined;
    void tauriListen<string>("install-log", (line) => {
      setInstallLogs((prev) => prev + line + "\n");
    }).then((u) => { unlog = u; });
    void tauriListen<{ ok: boolean; error?: string; url?: string; log?: string }>("install-done", (d) => {
      setInstalling(false);
      if (d.ok) {
        toast.success("操作完成，本機 Server 已就緒");
        setInstallOpen(false);
        void load();
        onSdkUpdated();
        if (d.url && window.location.origin !== d.url) void tauriInvoke("open_url", { url: d.url });
      } else {
        setInstallErr(`${d.error || "操作失敗"}\n紀錄：${d.log || ""}`);
      }
    }).then((u) => { undone = u; });
    return () => { unlog?.(); undone?.(); };
  }, [load, onSdkUpdated]);

  const startLocalInstall = async (force = false) => {
    setInstallTitle("安裝本機 Server");
    setInstallDesc("會使用本機 Node.js 下載並安裝 server 所需套件。");
    setInstallLogs("");
    setInstallErr(undefined);
    setInstalling(true);
    setInstallOpen(true);
    try {
      await tauriInvoke("install_local", { force });
    } catch (e) {
      setInstalling(false);
      setInstallErr(String(e));
    }
  };

  const startSdkUpdate = React.useCallback(async () => {
    setInstallTitle("更新 Claude Agent SDK");
    setInstallDesc("正在更新本機 Server 的 Claude Agent SDK，完成後會自動重啟本機 Server。");
    setInstallLogs("");
    setInstallErr(undefined);
    setInstalling(true);
    setInstallOpen(true);
    try {
      await tauriInvoke("update_sdk");
    } catch (e) {
      setInstalling(false);
      setInstallErr(String(e));
    }
  }, []);

  React.useEffect(() => {
    registerSdkUpdate(st?.config.local ? () => { void startSdkUpdate(); } : undefined);
    return () => registerSdkUpdate(undefined);
  }, [registerSdkUpdate, st?.config.local, startSdkUpdate]);

  const submitRemote = async (e: React.FormEvent) => {
    e.preventDefault();
    setRemoteBusy(true);
    setRemoteErr(undefined);
    try {
      await tauriInvoke("use_remote", { url: remoteUrl });
      setRemoteOpen(false);
      toast.success("已切換為遠端 Server");
    } catch (error) {
      setRemoteErr(String(error));
    } finally {
      setRemoteBusy(false);
    }
  };

  const saveHostSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    const numPort = Number(port);
    if (!Number.isInteger(numPort) || numPort < 1 || numPort > 65535) {
      toast.error("連接埠必須在 1 到 65535 之間");
      return;
    }
    setHostBusy(true);
    try {
      const list = origins.split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean);
      await tauriInvoke("save_local_settings", { port: numPort, origins: list });
      setHostOpen(false);
      toast.success("已儲存設定");
      setTimeout(() => { void load(); }, 1000);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setHostBusy(false);
    }
  };

  const toggleAutostart = async (enabled: boolean) => {
    try {
      const actual = await tauriInvoke<boolean>("set_autostart", { enabled });
      setSt((prev) => prev ? { ...prev, autostart: actual } : prev);
    } catch (error) {
      toast.error(String(error));
    }
  };

  if (err && !st) {
    return (
      <ListGroup title="桌面端">
        <ListRow detail={err} icon={<Desktop />} label="無法讀取桌面端狀態" onClick={() => void load()} />
      </ListGroup>
    );
  }
  if (!st) return null;

  const nodeOk = "Ok" in st.node;
  const nodeDetail = nodeOk ? `Node.js ${(st.node as { Ok: string }).Ok}` : (st.node as { Err: string }).Err;
  const modeDetail = st.config.local
    ? `本機 Server（${st.server_running ? "運行中" : "未啟動"} · ${st.local_url}）`
    : (st.config.url ? `遠端 Server（${st.config.url}）` : "尚未設定");

  return (
    <>
      <ListGroup footer={`imnotcc 桌面版 v${st.app_version} · ${nodeDetail}`} title="桌面端連線">
        <ListRow detail={modeDetail} icon={st.config.local ? <Desktop /> : <Globe />} label="目前模式" />
        <ListRow detail="切換為 Client，連到其他電腦上的 imnotcc" icon={<Link />} label="連到遠端 Server…" onClick={() => setRemoteOpen(true)} />
        {!st.config.local ? (
          <ListRow
            detail={nodeOk ? "在這台電腦安裝並啟動本機 Server" : `${nodeDetail}，請先安裝 Node.js 20 以上`}
            icon={<Laptop />}
            label="將這台電腦設為本機 Server"
            onClick={() => {
              if (!nodeOk) {
                void tauriInvoke("open_node_download");
                toast.info("已開啟 Node.js 下載頁面，裝好後再點一次檢查");
                return;
              }
              void startLocalInstall(false);
            }}
          />
        ) : null}
      </ListGroup>

      <ServerList onChanged={(config) => setSt((prev) => prev ? { ...prev, config } : prev)} st={st} />

      {st.config.local ? (
        <ListGroup footer="僅在作為本機 Server（Host）時顯示，其他裝置的 PWA 不會看到。" title="本機 Server（Host）">
          <ListRow
            detail={`Port ${st.config.port}${st.config.origins.length ? ` · Origins: ${st.config.origins.join(", ")}` : " · 未設定公開網域"}`}
            icon={<Globe />}
            label="連接埠與公開網域（Origins）"
            onClick={() => setHostOpen(true)}
          />
          {st.has_password ? (
            <ListRow
              detail="在系統視窗裡顯示，網頁拿不到"
              icon={<Key />}
              label="顯示初始密碼"
              onClick={() => void tauriInvoke("show_password").catch((e) => toast.error(String(e)))}
            />
          ) : null}
          <ListRow
            icon={<ArrowsClockwise />}
            label="重新啟動本機 Server"
            onClick={() => void tauriInvoke("restart_local").then(() => {
              toast.success("已重新啟動本機 Server");
              setTimeout(() => { void load(); }, 1000);
            }).catch((e) => toast.error(String(e)))}
          />
          <ListRow
            detail={st.config.installed_version ? `已安裝套件 v${st.config.installed_version}` : undefined}
            icon={<Laptop />}
            label="更新 / 重裝本機 Server 套件"
            onClick={() => void startLocalInstall(true)}
          />
        </ListGroup>
      ) : null}

      <ListGroup title="系統與資料">
        <SwitchRow
          checked={st.autostart}
          detail="開機後自動在系統匣背景執行"
          label="登入 Windows 時自動啟動"
          onChange={(v) => void toggleAutostart(v)}
        />
        {st.config.local ? (
          <>
            <ListRow detail={st.data_dir} icon={<FolderOpen />} label="開啟資料資料夾" onClick={() => void tauriInvoke("open_data_dir")} />
            <ListRow detail={st.log_dir} icon={<FolderOpen />} label="開啟 Log 資料夾" onClick={() => void tauriInvoke("open_log_dir")} />
          </>
        ) : null}
      </ListGroup>

      <Sheet description="輸入要連線的 imnotcc 伺服器網址（例如 https://cc.example.com）。" onOpenChange={setRemoteOpen} open={remoteOpen} title="連到遠端 Server">
        <form className="grid gap-4 pb-2" onSubmit={submitRemote}>
          <Field error={remoteErr} label="Server 網址">
            {({ describedBy, id, invalid }) => (
              <Input aria-describedby={describedBy} aria-invalid={invalid || undefined} id={id} onChange={(e) => setRemoteUrl(e.target.value)} placeholder="https://" required type="url" value={remoteUrl} />
            )}
          </Field>
          <Button disabled={!remoteUrl.trim()} size="lg" status={remoteBusy ? "loading" : "idle"} type="submit" variant="primary">連線並切換</Button>
        </form>
      </Sheet>

      <Sheet description="有變更時會重啟本機 Server 套用，執行中的對話會中斷幾秒。新的 port 起不來會自動恢復原設定。" onOpenChange={setHostOpen} open={hostOpen} title="本機 Server 設定">
        <form className="grid gap-4 pb-2" onSubmit={saveHostSettings}>
          <Field label="連接埠（Port）">
            {({ id }) => <Input id={id} max={65535} min={1} onChange={(e) => setPort(e.target.value)} required type="number" value={port} />}
          </Field>
          <Field hint="對應 IMNOTCC_ORIGINS，每行一個或用逗號分隔" label="允許的公開網域（Origins）">
            {({ id }) => <Textarea id={id} onChange={(e) => setOrigins(e.target.value)} placeholder="https://cc.example.com" rows={3} value={origins} />}
          </Field>
          <Button size="lg" status={hostBusy ? "loading" : "idle"} type="submit" variant="primary">儲存並套用</Button>
        </form>
      </Sheet>

      <Sheet description={installDesc} onOpenChange={(o) => { if (!installing) setInstallOpen(o); }} open={installOpen} title={installTitle}>
        <div className="grid gap-3 pb-2">
          <pre className="max-h-60 overflow-auto rounded-lg border border-line bg-bg p-3 font-mono text-xs whitespace-pre-wrap">{installLogs || "準備中…"}</pre>
          {installErr ? <p className="text-sm text-danger whitespace-pre-wrap">{installErr}</p> : null}
          {!installing ? <Button onClick={() => setInstallOpen(false)} variant="ghost">關閉</Button> : null}
        </div>
      </Sheet>
    </>
  );
}

function ClaudeAccountSettings() {
  const { status } = useStore(claudeAuth);
  const [target, setTarget] = React.useState<ClaudeTarget>();
  React.useEffect(() => { void refreshClaudeAuth(); }, []);
  const targets = Object.keys(status) as ClaudeTarget[];
  if (!targets.length) return null;
  return (
    <>
      <ListGroup title="Claude 帳號">
        {targets.map((t) => {
          const s = status[t]!;
          const detail = s.loggedIn === null ? (s.error ?? "讀不到狀態")
            : !s.loggedIn ? (s.expired ? "登入已失效" : "還沒登入")
            : [s.email, s.authMethod].filter(Boolean).join(" · ") || "已登入";
          return <ListRow detail={detail} icon={<Key />} key={t} label={`${TARGET_LABEL[t]}：${s.loggedIn ? "重新登入" : "登入"}`} onClick={() => setTarget(t)} />;
        })}
      </ListGroup>
      {target ? <ClaudeLoginSheet onOpenChange={(o) => { if (!o) setTarget(undefined); }} open target={target} /> : null}
    </>
  );
}

export function AppSettingsPage() {
  const view = useStore(prefs);
  const [passwordOpen, setPasswordOpen] = React.useState(false);
  const [logoutOpen, setLogoutOpen] = React.useState(false);
  const [desktopReload, setDesktopReload] = React.useState(0);
  const [sdkReload, setSdkReload] = React.useState(0);
  const [isLocalHost, setIsLocalHost] = React.useState(false);
  const sdkUpdateRef = React.useRef<(() => void) | undefined>(undefined);
  const registerSdkUpdate = React.useCallback((fn: (() => void) | undefined) => {
    sdkUpdateRef.current = fn;
  }, []);
  const bumpSdkReload = React.useCallback(() => setSdkReload((n) => n + 1), []);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <PageHeader title="App 設定" />

      <ListGroup title="對話顯示">
        <SwitchRow checked={view.groupTools} detail="每個回合的工作過程收成「處理了幾分鐘」，只留最後的回覆和改過的檔案" label="折疊工作過程" onChange={(v) => prefs.set({ groupTools: v })} />
        <SwitchRow checked={view.bubbles} label="回覆用對話氣泡" onChange={(v) => prefs.set({ bubbles: v })} />
        <SwitchRow checked={view.hideWork} detail="只留你和 Claude 的對話，執行中會顯示正在用的工具" disabled={!view.bubbles} label="氣泡模式隱藏思考和工具" onChange={(v) => prefs.set({ hideWork: v })} />
        <SwitchRow checked={view.reduceMotion} label="減少動態效果" onChange={(v) => prefs.set({ reduceMotion: v })} />
      </ListGroup>

      <ListGroup footer="長按送出鍵或按 Ctrl+Enter，可單次改用另一種。" title="Claude 工作中送出訊息">
        <PickerRow label="預設方式" onChange={(busySend) => prefs.set({ busySend })} options={[
          { label: "加入佇列（這回合結束後送出）", value: "queue" },
          { label: "引導（插進目前這一回合）", value: "steer" },
        ]} value={view.busySend} />
      </ListGroup>

      <ClaudeAccountSettings />

      <NotificationSettings />

      <ProjectSessionsSettings limit={view.projectSessionLimit} />

      <LocalStorageSettings />

      <AgentSdkSettings
        canUpdateLocally={isTauri() && isLocalHost}
        onStartUpdate={() => sdkUpdateRef.current?.()}
        reloadKey={sdkReload}
      />

      {isTauri() ? (
        <DesktopSettings
          onLocalChange={setIsLocalHost}
          onSdkUpdated={bumpSdkReload}
          registerSdkUpdate={registerSdkUpdate}
          reloadKey={desktopReload}
        />
      ) : null}

      <ListGroup title="帳號">
        <ListRow icon={<Key />} label="更改密碼" onClick={() => setPasswordOpen(true)} />
        <ListRow icon={<SignOut />} label="登出" onClick={() => setLogoutOpen(true)} tone="danger" />
      </ListGroup>

      <PasswordSheet onChanged={() => setDesktopReload((n) => n + 1)} onOpenChange={setPasswordOpen} open={passwordOpen} />
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
