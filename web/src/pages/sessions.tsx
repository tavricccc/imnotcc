import * as React from "react";
import { ArrowRight, ArrowUp, Copy, FolderSimple, PencilSimple, Trash, FolderSimplePlus, GearSix, HardDrives, LinuxLogo, NotePencil, Plus, SidebarSimple, WindowsLogo } from "@phosphor-icons/react/ssr";
import { toast } from "sonner";
import { del, get, post } from "@/lib/api";
import { clearCache } from "@/lib/cache";
import { removeLocalTranscript } from "@/lib/local-transcript";
import { RenameDialog } from "@/components/rename-dialog";
import { ConfirmDialog } from "@/ui/confirm-dialog";
import { useContextItems, type ContextItem } from "@/ui/context-menu";
import { isTauri } from "@/lib/tauri";
import { navigate } from "@/lib/app-navigation";
import { ago, baseName, until } from "@/lib/format";
import { onGlobal } from "@/lib/socket";
import { useCached } from "@/lib/cache";
import { prefs } from "@/lib/prefs";
import { useSessions, type SessionRow } from "@/lib/resources";
import { shared, type Plan } from "@/lib/store";
import { useStore } from "@/lib/store-core";
import { UsageRing, Meter } from "@/components/usage-ring";
import { AppLink } from "@/ui/app-link";
import { Button } from "@/ui/button";
import { Chip } from "@/ui/chip";
import { Input } from "@/ui/field";
import { ListGroup, ListRow } from "@/ui/list";
import { Dialog } from "@/ui/dialog";
import { Pane, useStepDirection } from "@/ui/pane";
import { EmptyState, ErrorState, LoadingList, PageHeader } from "@/ui/page";
import { Sheet } from "@/ui/sheet";
import { Segmented, type SegmentedOption } from "@/ui/segmented";
import { cn } from "@/lib/utils";

export type Env = "win" | "wsl";
/** A folder written as a Linux path ("/home/...") is inside WSL. */
export const envOf = (cwd: string): Env => (cwd.startsWith("/") ? "wsl" : "win");
export const ENV_LABEL: Record<Env, string> = { win: "Windows", wsl: "WSL" };
const environments: SegmentedOption<Env>[] = [
  { value: "win", label: ENV_LABEL.win, icon: <WindowsLogo /> },
  { value: "wsl", label: ENV_LABEL.wsl, icon: <LinuxLogo /> },
];

export function SessionsPage({ activeId, onOpenSettings, onToggleSidebar, revision = 0, sidebar = false }: {
  activeId?: string;
  onOpenSettings?: () => void;
  onToggleSidebar?: () => void;
  revision?: number;
  sidebar?: boolean;
}) {
  const { plan, running } = useStore(shared);
  const { data, error, reload: load } = useSessions();
  const { groups, recent = [] } = data ?? {};
  const { data: roots } = useCached(folderUrl(null), () => readFolder(null));
  const { projectSessionLimit, sessionEnvironment } = useStore(prefs);
  const nativePosix = !!roots?.home?.startsWith("/");
  const canSwitch = !!roots?.wslHome || (!nativePosix && (
    !!groups?.some((g) => envOf(g.cwd) === "wsl") || recent.some((s) => envOf(s.cwd) === "wsl")
  ));
  const env: Env = canSwitch ? sessionEnvironment : nativePosix ? "wsl" : "win";
  const visibleGroups = groups?.filter((g) => envOf(g.cwd) === env).map((g) => ({
    ...g,
    sessions: projectSessionLimit === "all" ? g.sessions : g.sessions.slice(0, Number(projectSessionLimit)),
  }));
  const visibleRecent = recent.filter((s) => envOf(s.cwd) === env);
  const [usageOpen, setUsageOpen] = React.useState(false);

  // ---- What can be done to one conversation: right-click it, or long-press it on a phone ----
  const root = React.useRef<HTMLDivElement>(null);
  const [acting, setActing] = React.useState<{ row: SessionRow; what: "menu" | "rename" | "remove" } | null>(null);
  const [actingOpen, setActingOpen] = React.useState(false);
  const rows = React.useMemo(() => new Map([...(groups ?? []).flatMap((g) => g.sessions), ...recent].map((r) => [r.id, r])), [groups, recent]);
  const rowAt = React.useRef((_: EventTarget | null): SessionRow | undefined => undefined);
  rowAt.current = (target) => {
    const link = target instanceof Element ? target.closest<HTMLAnchorElement>('a[href^="#/s/"]') : null;
    return link ? rows.get(link.getAttribute("href")!.slice(4)) : undefined;
  };
  const act = (row: SessionRow, what: "menu" | "rename" | "remove") => { setActing({ row, what }); setActingOpen(true); };
  const rowActions = (row: SessionRow): ContextItem[] => [
    { key: "open", label: "開啟", icon: ArrowRight, onSelect: () => navigate(`/s/${row.id}`) },
    { key: "rename", label: "重新命名", icon: PencilSimple, onSelect: () => act(row, "rename") },
    { key: "copy-id", label: "複製 ID", icon: Copy, onSelect: () => { void navigator.clipboard.writeText(row.id).then(() => toast.success("已複製 ID"), () => {}); } },
    { key: "remove", label: "移除", icon: Trash, tone: "danger", onSelect: () => act(row, "remove") },
  ];
  useContextItems(root, (target) => { const row = rowAt.current(target); return row ? rowActions(row) : null; });
  React.useEffect(() => {
    const el = root.current;
    if (!el) return;
    let timer = 0;
    let start: { x: number; y: number } | null = null;
    let fired = false;
    const cancel = () => { window.clearTimeout(timer); start = null; };
    const down = (e: PointerEvent) => {
      fired = false;
      if (e.pointerType !== "touch") return;
      const row = rowAt.current(e.target);
      if (!row) return;
      start = { x: e.clientX, y: e.clientY };
      timer = window.setTimeout(() => { fired = true; start = null; navigator.vibrate?.(10); act(row, "menu"); }, 500);
    };
    const move = (e: PointerEvent) => { if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) cancel(); };
    // The press that opened the sheet does not also open the conversation.
    const click = (e: MouseEvent) => { if (fired) { fired = false; e.preventDefault(); e.stopPropagation(); } };
    // Nor the phone's own link menu.
    const menu = (e: Event) => { if (fired || start) e.preventDefault(); };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", cancel);
    el.addEventListener("pointercancel", cancel);
    el.addEventListener("click", click, true);
    el.addEventListener("contextmenu", menu);
    return () => {
      cancel();
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", cancel);
      el.removeEventListener("pointercancel", cancel);
      el.removeEventListener("click", click, true);
      el.removeEventListener("contextmenu", menu);
    };
  }, []);
  async function rename(row: SessionRow, title: string) {
    await post(`/api/sessions/${row.id}/rename`, { title });
    clearCache(`/api/sessions/${row.id}`);
    // An open chat of this conversation shows the new name too.
    window.dispatchEvent(new CustomEvent("imnotcc:renamed", { detail: { id: row.id, title } }));
    setActingOpen(false);
    void load();
  }
  async function remove(row: SessionRow) {
    try {
      await del(`/api/sessions/${row.id}`);
      void removeLocalTranscript(row.id).catch(() => {});
      clearCache(`/api/sessions/${row.id}`);
      if (row.id === activeId) navigate("/", { replace: true });
      void load();
    } catch (e) { toast.error((e as Error).message); }
  }
  const [usageStatus, setUsageStatus] = React.useState<"idle" | "loading" | "error">("idle");

  React.useEffect(() => {
    const timer = setInterval(load, 30_000);
    const off = onGlobal((m) => { if (m.kind === "running" && !m.running) void load(); });
    return () => { clearInterval(timer); off(); };
  }, [load]);
  React.useEffect(() => {
    if (sidebar) void load();
  }, [activeId, load, revision, sidebar]);

  const five = plan?.fiveHour?.pct ?? null;
  const seven = plan?.sevenDay?.pct ?? null;

  async function openUsage() {
    setUsageOpen(true);
    if (usageStatus === "loading") return;
    setUsageStatus("loading");
    try {
      const { plan } = await get<{ plan: Plan | null }>("/api/usage?refresh=1");
      shared.set({ plan });
      setUsageStatus("idle");
    } catch {
      setUsageStatus("error");
    }
  }

  function openDraft(cwd?: string) {
    const params = new URLSearchParams({ env });
    if (cwd) params.set("cwd", cwd);
    navigate(`/new?${params}`);
  }

  const actions = (
    <>
      <UsageRing label={five == null && seven == null ? "方案用量" : `方案用量：5 小時 ${five ?? "–"}%，每週 ${seven ?? "–"}%`} onClick={() => void openUsage()} pct={five == null && seven == null ? null : Math.max(five ?? 0, seven ?? 0)} />
      {!sidebar && onOpenSettings ? <Button aria-label="設定" onClick={onOpenSettings} size="icon"><GearSix /></Button> : null}
      {sidebar ? null : <Button aria-label="新增對話" onClick={() => openDraft()} size="icon" variant="primary"><Plus weight="bold" /></Button>}
    </>
  );

  function sessionRow(s: SessionRow) {
    const title = s.title || (s.temporary ? "Temp Chat" : "新的對話");
    const isRunning = s.running || running[s.id];
    const href = `/s/${s.id}`;
    if (sidebar) {
      return (
        <li key={s.id}>
          <AppLink aria-current={s.id === activeId ? "page" : undefined}
            className={cn("flex min-h-9 items-center gap-2 rounded-tile py-1 pr-2 text-sm outline-none transition-colors duration-[var(--motion-control)] ease-[var(--ease-move)] hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]", s.temporary ? "pl-2" : "pl-7", s.id === activeId && "bg-surface-pressed font-medium hover:bg-surface-pressed")}
            href={href} title={title}>
            <span className="min-w-0 flex-1 truncate">{title}</span>
            {isRunning ? <span aria-label="執行中" className="pulse-dot !bg-positive" role="img" /> : null}
          </AppLink>
        </li>
      );
    }
    return (
      <ListRow href={href} key={s.id} label={title}
        value={isRunning ? <Chip className="align-middle" tone="positive"><span className="pulse-dot !bg-positive" />執行中</Chip> : ago(s.lastModified)} />
    );
  }

  const sidebarNavClass = (current: boolean) => cn(
    "flex h-8.5 items-center gap-2.5 rounded-tile px-2.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]",
    current ? "bg-surface-pressed text-ink" : "text-ink-muted hover:bg-surface-raised hover:text-ink",
  );

  return (
    <div className={cn(sidebar ? "flex h-full min-h-0 flex-col" : "grid grid-cols-[minmax(0,1fr)] gap-6", "[&_a[href^='#/s/']]:[-webkit-touch-callout:none]")} ref={root}>
      <div className={sidebar ? "grid shrink-0 gap-1 px-2.5 pb-2 pt-[calc(var(--safe-top)+0.5rem)]" : "contents"}>
        {sidebar ? (
          <>
            {!isTauri() && onToggleSidebar ? (
              <div className="mb-1 flex items-center justify-between px-1.5">
                <div className="flex items-center gap-2 text-xs font-semibold tracking-wide text-ink-muted">
                  <img alt="" className="size-4 rounded-[22.37%]" src="/icon.svg" />
                  <span>imnotcc</span>
                </div>
                <Button aria-label="收起側邊欄" onClick={onToggleSidebar} size="icon-sm" variant="ghost">
                  <SidebarSimple size={16} weight="fill" />
                </Button>
              </div>
            ) : null}
            <button className={cn(sidebarNavClass(false), "w-full text-left")} onClick={() => openDraft()} type="button">
              <NotePencil className="size-4 shrink-0" />
              <span>新增對話</span>
            </button>
          </>
        ) : <PageHeader actions={actions} title="對話" />}

        {canSwitch ? (
          <Segmented className={sidebar ? "mt-1.5 [&_[role=tablist]]:overflow-x-hidden [&_[role=tab]]:px-3" : undefined} label="執行環境" onChange={(value) => prefs.set({ sessionEnvironment: value })} options={environments} value={env} />
        ) : null}
      </div>

      <div className={sidebar ? "min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-3 pb-4" : "contents"}>
      {error ? <ErrorState message={error} onRetry={() => void load()} retryLabel="重試" title="讀不到對話" />
        : !visibleGroups ? <LoadingList label="載入中" rows={3} />
        : !visibleGroups.length && !visibleRecent.length ? (
          sidebar ? <p className="px-2 py-4 text-sm text-ink-muted">還沒有對話</p>
            : <EmptyState action={<Button onClick={() => openDraft()} variant="primary"><Plus weight="bold" />開一個新的</Button>} description="開啟 Temp Chat 或選擇資料夾，就能跟 Claude Code 對話。" title="還沒有對話" />
        ) : sidebar ? (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
            {visibleGroups.map((g) => (
              <section aria-label={baseName(g.cwd)} key={g.cwd}>
                <div className="flex items-center gap-1.5 pl-2">
                  <FolderSimple aria-hidden className="size-4 shrink-0 text-ink-muted" />
                  <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-ink-muted" title={baseName(g.cwd)}>{baseName(g.cwd)}</h3>
                  <Button aria-label={`在 ${baseName(g.cwd)} 開新的 session`} onClick={() => openDraft(g.cwd)} size="icon-sm" variant="ghost"><Plus /></Button>
                </div>
                <ul>{g.sessions.map(sessionRow)}</ul>
              </section>
            ))}
            {visibleRecent.length ? (
              <section aria-label="最近項目" className="mt-3">
                <h3 className="px-2 pb-1 text-sm font-medium text-ink-muted">最近項目</h3>
                <ul>{visibleRecent.map(sessionRow)}</ul>
              </section>
            ) : null}
          </div>
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
            {visibleGroups.map((g) => (
              <ListGroup
                action={<Button aria-label={`在 ${baseName(g.cwd)} 開新的 session`} onClick={() => openDraft(g.cwd)} size="icon-sm" variant="ghost"><Plus weight="bold" /></Button>}
                key={g.cwd}
                title={baseName(g.cwd)}
              >
                {g.sessions.map(sessionRow)}
              </ListGroup>
            ))}
            {visibleRecent.length ? <ListGroup title="最近項目">{visibleRecent.map(sessionRow)}</ListGroup> : null}
          </div>
        )}
      </div>

      {sidebar ? (
        <footer className="flex shrink-0 items-center justify-between gap-2 px-2.5 py-2.5">
          <button className={cn(sidebarNavClass(false), "flex-1 text-left")} onClick={onOpenSettings} type="button">
            <GearSix className="size-4 shrink-0" />
            <span>設定</span>
          </button>
          <UsageRing
            label={five == null && seven == null ? "方案用量" : `方案用量：5 小時 ${five ?? "–"}%，每週 ${seven ?? "–"}%`}
            onClick={() => void openUsage()}
            pct={five == null && seven == null ? null : Math.max(five ?? 0, seven ?? 0)}
          />
        </footer>
      ) : null}

      <Sheet onOpenChange={setActingOpen} open={actingOpen && acting?.what === "menu"} title={acting ? acting.row.title || (acting.row.temporary ? "Temp Chat" : "新的對話") : ""}>
        <ListGroup>
          {acting ? rowActions(acting.row).map(({ icon: ItemIcon, key, label, onSelect, tone }) => (
            <ListRow icon={<ItemIcon />} key={key} label={label} onClick={() => { if (key !== "rename" && key !== "remove") setActingOpen(false); onSelect(); }} tone={tone} />
          )) : null}
        </ListGroup>
      </Sheet>
      <RenameDialog
        initial={acting?.row.title ?? ""}
        onOpenChange={setActingOpen}
        onSave={(title) => rename(acting!.row, title)}
        open={actingOpen && acting?.what === "rename"}
      />
      <ConfirmDialog
        confirmLabel="移除"
        description="只是從 imnotcc 的列表拿掉，電腦上的紀錄檔會留著。"
        onConfirm={() => { if (acting) void remove(acting.row); }}
        onOpenChange={setActingOpen}
        open={actingOpen && acting?.what === "remove"}
        title="移除這個對話？"
        tone="danger"
      />

      <Sheet onOpenChange={setUsageOpen} open={usageOpen} title="方案用量">
        <div className="grid gap-5 pb-2">
          {usageStatus === "error" && !plan ? <p className="text-sm text-danger" role="alert">無法更新用量。</p> : null}
          {usageStatus === "idle" && five == null && seven == null ? <p className="text-sm text-ink-muted" role="status">目前沒有方案用量資料。</p> : null}
          <Meter label="5 小時" note={until(plan?.fiveHour?.resetsAt)} pct={five} value={five == null ? "—" : `${Math.round(five)}%`} />
          <Meter label="每週" note={until(plan?.sevenDay?.resetsAt)} pct={seven} value={seven == null ? "—" : `${Math.round(seven)}%`} />
        </div>
      </Sheet>
    </div>
  );
}

interface Listing { path: string | null; parent: string | null; dirs: string[]; home?: string; wslHome?: string | null }
export const folderUrl = (path: string | null) => `/api/fs${path ? `?path=${encodeURIComponent(path)}` : ""}`;
export const readFolder = (path: string | null) => get<Listing>(folderUrl(path));
// A path starting with "/" is inside WSL and joins with "/".
const join = (base: string, name: string) => (/[\\/]$/.test(base) ? base + name : `${base}${base.startsWith("/") ? "/" : "\\"}${name}`);
const depthOf = (p: string | null) => (p ? p.split(/[\\/]/).filter(Boolean).length : 0);

/** Walks this computer's folders, starting at the home folder; can make a folder on the way. */
/** In WSL the walk stays inside WSL: it starts at WSL's home and stops at "/". */
export function FolderBrowserSheet({ env, onChoose, onOpenChange, onClosed, open }: { env: Env; onChoose: (path: string) => void; onOpenChange: (open: boolean) => void; open: boolean; onClosed?: () => void }) {
  const [selected, setSelected] = React.useState<string | null>();
  const [mkdirOpen, setMkdirOpen] = React.useState(false);
  const { data: roots, error: rootsError, reload: reloadRoots } = useCached(folderUrl(null), () => readFolder(null), open);
  const home = env === "wsl" ? roots?.wslHome ?? (roots?.home?.startsWith("/") ? roots.home : null) : roots?.home;
  const path = selected === undefined ? home ?? null : selected;
  const { data: listing, error: listingError, reload } = useCached(folderUrl(path), () => readFolder(path), open && !!path);
  const error = listingError || rootsError;
  const here = listing?.path ?? null;
  const direction = useStepDirection(here ?? "", depthOf(here));
  const dirs = listing?.dirs.filter((d) => here || (env === "wsl") === (d === "/")) ?? [];

  React.useEffect(() => {
    if (!open) { setSelected(undefined); setMkdirOpen(false); }
  }, [open]);

  return (
    <Sheet
      description={<span className="block truncate font-mono text-[0.8125rem]">{here ?? "這台電腦"}</span>}
      footer={
        <>
          <Button disabled={!here} onClick={() => setMkdirOpen(true)}><FolderSimplePlus />新資料夾</Button>
          <Button disabled={!here} onClick={() => { if (here) onChoose(here); }} variant="primary">選這個資料夾</Button>
        </>
      }
      onOpenChange={onOpenChange}
      open={open}
      title="瀏覽資料夾"
      onClosed={onClosed}
    >
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 pb-2">
        {error ? <p className="message-in px-1 text-sm text-danger" role="alert">{error}</p> : null}
        {listing ? (
          <Pane direction={direction} step={here ?? ""}>
            <ListGroup title={here ? baseName(here) : "磁碟"}>
              {here && (listing.parent || env === "win") ? <ListRow icon={<ArrowUp />} label="上一層" onClick={() => setSelected(listing.parent)} value={listing.parent ? baseName(listing.parent) : "磁碟"} /> : null}
              {dirs.map((d) => (
                <ListRow icon={here ? <FolderSimple /> : <HardDrives />} key={d} label={here ? d : d === "/" ? "WSL" : d.replace(/[\\/]$/, "")} onClick={() => setSelected(here ? join(here, d) : d)} />
              ))}
              {here && !listing.dirs.length ? <ListRow label={<span className="text-ink-faint">沒有子資料夾</span>} /> : null}
            </ListGroup>
          </Pane>
        ) : error ? (
          <div className="flex gap-2">
            <Button onClick={() => void (path ? reload() : reloadRoots())}>重試</Button>
            {selected !== undefined ? <Button onClick={() => setSelected(undefined)}>回到家目錄</Button> : null}
          </div>
        ) : <LoadingList label="載入中" rows={4} />}
      </div>
      <MkdirDialog onCreated={(path) => { setMkdirOpen(false); void reload(); setSelected(path); }} onOpenChange={setMkdirOpen} open={mkdirOpen} parent={here} />
    </Sheet>
  );
}

function MkdirDialog({ onCreated, onOpenChange, open, parent }: { onCreated: (path: string) => void; onOpenChange: (o: boolean) => void; open: boolean; parent: string | null }) {
  const [name, setName] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { if (open) { setName(""); setError(""); } }, [open]);
  async function create() {
    setBusy(true);
    try { onCreated((await post("/api/fs/mkdir", { path: parent, name: name.trim() })).path); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog
      actions={
        <>
          <Button onClick={() => onOpenChange(false)}>取消</Button>
          <Button disabled={!name.trim()} onClick={() => void create()} status={busy ? "loading" : "idle"} variant="primary">建立</Button>
        </>
      }
      description={parent ?? undefined}
      onOpenChange={onOpenChange}
      open={open}
      title="新資料夾"
    >
      <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void create(); }}>
        <Input aria-label="資料夾名稱" autoFocus onChange={(e) => setName(e.target.value)} placeholder="名稱" spellCheck={false} value={name} />
        {error ? <p className="message-in px-1 text-sm text-danger" role="alert">{error}</p> : null}
      </form>
    </Dialog>
  );
}
