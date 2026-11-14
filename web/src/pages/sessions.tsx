import * as React from "react";
import { ArrowUp, FolderSimple, FolderSimplePlus, HardDrives, LinuxLogo, Plus, WindowsLogo } from "@phosphor-icons/react/ssr";
import { get, post } from "@/lib/api";
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

export function SessionsPage({ activeId, revision = 0, sidebar = false }: { activeId?: string; revision?: number; sidebar?: boolean }) {
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
      {sidebar ? null : <Button aria-label="新增 Session" onClick={() => openDraft()} size="icon" variant="primary"><Plus weight="bold" /></Button>}
    </>
  );

  function sessionRow(s: SessionRow) {
    const title = s.title || (s.temporary ? "Temp Chat" : "新的 session");
    const isRunning = s.running || running[s.id];
    const href = `/s/${s.id}`;
    if (sidebar) {
      return (
        <li key={s.id}>
          <AppLink aria-current={s.id === activeId ? "page" : undefined}
            className={cn("flex min-h-9 items-center gap-2 rounded-tile py-1 pr-2 text-sm outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]", s.temporary ? "pl-2" : "pl-7", s.id === activeId && "bg-surface-pressed font-medium hover:bg-surface-pressed")}
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

  return (
    <div className={sidebar ? "flex h-full min-h-0 flex-col" : "grid grid-cols-[minmax(0,1fr)] gap-6"}>
      <div className={sidebar ? "grid shrink-0 gap-3 px-3 pb-3 pt-4" : "contents"}>
        {sidebar ? (
          <header className="flex items-center justify-between gap-2 pl-1">
            <h2 className="text-base font-semibold">Session</h2>
            <div className="flex items-center gap-1">{actions}</div>
          </header>
        ) : <PageHeader actions={actions} title="Session" />}

        {sidebar ? <Button className="justify-start px-2" onClick={() => openDraft()} size="sm" variant="ghost"><Plus weight="bold" />新增 Session</Button> : null}

        {canSwitch ? (
          <Segmented className={sidebar ? "[&_[role=tablist]]:overflow-x-hidden [&_[role=tab]]:px-3" : undefined} label="執行環境" onChange={(value) => prefs.set({ sessionEnvironment: value })} options={environments} value={env} />
        ) : null}
      </div>

      <div className={sidebar ? "min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-3 pb-4" : "contents"}>
      {error ? <ErrorState message={error} onRetry={() => void load()} retryLabel="重試" title="讀不到 session" />
        : !visibleGroups ? <LoadingList label="載入中" rows={3} />
        : !visibleGroups.length && !visibleRecent.length ? (
          sidebar ? <p className="px-2 py-4 text-sm text-ink-muted">還沒有 session</p>
            : <EmptyState action={<Button onClick={() => openDraft()} variant="primary"><Plus weight="bold" />開一個新的</Button>} description="開啟 Temp Chat 或選擇資料夾，就能跟 Claude Code 對話。" title="還沒有 session" />
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
