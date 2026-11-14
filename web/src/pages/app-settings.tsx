import * as React from "react";
import { toast } from "sonner";
import { ArrowsClockwise, Desktop, FolderOpen, Globe, Key, Laptop, Link, SignOut, Trash } from "@phosphor-icons/react/ssr";
import { auth, post } from "@/lib/api";
import { claudeAuth, refreshClaudeAuth, TARGET_LABEL, type ClaudeTarget } from "@/lib/claude-auth";
import { ClaudeLoginSheet } from "@/components/claude-login";
import { clearCache } from "@/lib/cache";
import { removeLocalTranscripts } from "@/lib/local-transcript";
import { prefs, SESSION_LIMITS } from "@/lib/prefs";
import { disablePush, enablePush, push, refreshPush, testPush, type PushState } from "@/lib/push";
import { readSessions } from "@/lib/resources";
import { useStore } from "@/lib/store-core";
import { isTauri, tauriInvoke, tauriListen, type DesktopState } from "@/lib/tauri";
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
    <ListGroup footer="每台裝置各自設定。正在看的對話不會再跳通知。" title="通知">
      <SwitchRow checked={state === "on"} detail={PUSH_DETAIL[state]} disabled={busy || (state !== "on" && state !== "off")} label="推播通知" onChange={(on) => void toggle(on)} />
      {state === "on" ? <ListRow label="傳送測試通知" onClick={() => void testPush().catch((e) => toast.error((e as Error).message))} /> : null}
    </ListGroup>
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
      <ListGroup footer="依最後更新時間顯示。設定保留數量後，可清理超出數量的本機快取。" title="專案對話">
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

function DesktopSettings() {
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
  const [installLogs, setInstallLogs] = React.useState("");
  const [installErr, setInstallErr] = React.useState<string>();
  const [installing, setInstalling] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const next = await tauriInvoke<DesktopState>("get_state");
      setSt(next);
      setErr(undefined);
      setPort(String(next.config.port || 4280));
      setOrigins((next.config.origins || []).join("\n"));
      if (!next.config.local && next.config.url) setRemoteUrl(next.config.url);
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    let unlog: (() => void) | undefined;
    let undone: (() => void) | undefined;
    void tauriListen<string>("install-log", (line) => {
      setInstallLogs((prev) => prev + line + "\n");
    }).then((u) => { unlog = u; });
    void tauriListen<{ ok: boolean; error?: string; url?: string; log?: string }>("install-done", (d) => {
      setInstalling(false);
      if (d.ok) {
        toast.success("本機 Server 已安裝並啟動");
        setInstallOpen(false);
        void load();
        if (d.url) void tauriInvoke("open_url", { url: d.url });
      } else {
        setInstallErr(`${d.error || "安裝失敗"}\n紀錄：${d.log || ""}`);
      }
    }).then((u) => { undone = u; });
    return () => { unlog?.(); undone?.(); };
  }, [load]);

  const startLocalInstall = async () => {
    setInstallLogs("");
    setInstallErr(undefined);
    setInstalling(true);
    setInstallOpen(true);
    try {
      await tauriInvoke("install_local");
    } catch (e) {
      setInstalling(false);
      setInstallErr(String(e));
    }
  };

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
              void startLocalInstall();
            }}
          />
        ) : null}
      </ListGroup>

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
            onClick={() => void startLocalInstall()}
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
          <Field hint="對應 CC_REMOTE_ORIGINS，每行一個或用逗號分隔" label="允許的公開網域（Origins）">
            {({ id }) => <Textarea id={id} onChange={(e) => setOrigins(e.target.value)} placeholder="https://cc.example.com" rows={3} value={origins} />}
          </Field>
          <Button size="lg" status={hostBusy ? "loading" : "idle"} type="submit" variant="primary">儲存並套用</Button>
        </form>
      </Sheet>

      <Sheet description="會使用本機 Node.js 下載並安裝 server 所需套件。" onOpenChange={(o) => { if (!installing) setInstallOpen(o); }} open={installOpen} title="安裝本機 Server">
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
      <ListGroup footer="Server 電腦上 Claude Code 的登入。Windows 和 WSL 的對話各自登入。" title="Claude 帳號">
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

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <PageHeader title="App 設定" />

      <ListGroup footer="只存在這個裝置上。" title="對話顯示">
        <SwitchRow checked={view.groupTools} detail="每個回合的工作過程收成「處理了幾分鐘」，只留最後的回覆和改過的檔案" label="折疊工作過程" onChange={(v) => prefs.set({ groupTools: v })} />
        <SwitchRow checked={view.bubbles} label="回覆用對話氣泡" onChange={(v) => prefs.set({ bubbles: v })} />
        <SwitchRow checked={view.hideWork} detail="只留你和 Claude 的對話，執行中會顯示正在用的工具" disabled={!view.bubbles} label="氣泡模式隱藏思考和工具" onChange={(v) => prefs.set({ hideWork: v })} />
      </ListGroup>

      <ListGroup footer="長按送出鍵，或在電腦上按 Ctrl+Enter，可以單次改用另一種。Shift+Enter 換行。" title="Claude 工作中送出訊息">
        <PickerRow label="預設方式" onChange={(busySend) => prefs.set({ busySend })} options={[
          { label: "加入佇列（這回合結束後送出）", value: "queue" },
          { label: "引導（插進目前這一回合）", value: "steer" },
        ]} value={view.busySend} />
      </ListGroup>

      <ClaudeAccountSettings />

      <NotificationSettings />

      <ProjectSessionsSettings limit={view.projectSessionLimit} />

      {isTauri() ? <DesktopSettings /> : null}

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
