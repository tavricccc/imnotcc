import * as React from "react";
import { toast } from "sonner";
import { ArrowClockwise, MagnifyingGlass, Plus, PuzzlePiece, Storefront } from "@phosphor-icons/react/ssr";
import { get, post } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useCached } from "@/lib/cache";
import { Button } from "@/ui/button";
import { ConfirmDialog } from "@/ui/confirm-dialog";
import { Field, Input } from "@/ui/field";
import { ListGroup, ListRow, rowClass } from "@/ui/list";
import { EmptyState, ErrorState, LoadingList, PageHeader } from "@/ui/page";
import { Sheet } from "@/ui/sheet";
import { Switch } from "@/ui/switch";

interface Installed { id: string; version?: string; scope?: string; enabled: boolean }
interface Market { name: string; source?: string }
interface Overview { installed: Installed[]; marketplaces: Market[] }

const pluginName = (id: string) => id.split("@")[0];
const marketName = (id: string) => id.split("@")[1] ?? "";

/** Runs one `claude plugin` action; what the CLI printed comes back as a toast. */
async function runAction(action: string, name: string, scope?: string) {
  try {
    const r = await post(`/api/plugins/${action}`, { name, scope });
    toast.success(r.output?.trim() || "完成");
    return true;
  } catch (e) {
    toast.error((e as Error).message);
    return false;
  }
}

function usePlugins() {
  const { data, error, reload: load } = useCached<Overview>("plugins", async () => {
    const r = await get("/api/plugins");
    return { installed: r.installed, marketplaces: r.marketplaces };
  });
  return { data, error, load };
}

// ---- Plugin ----

export function PluginsPage() {
  const { data, error, load } = usePlugins();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<Installed | null>(null);
  const [confirmRemove, setConfirmRemove] = React.useState(false);

  async function run(action: string, p: Installed) {
    setBusy(`${action}:${p.id}`);
    const ok = await runAction(action, p.id, p.scope);
    await load();
    setBusy(null);
    return ok;
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <PageHeader actions={<Button aria-label="重新整理" onClick={() => void load()} size="icon"><ArrowClockwise weight="bold" /></Button>} title="Plugin" />
      {error ? <ErrorState message={error} onRetry={() => void load()} retryLabel="重試" title="讀不到 plugin" />
        : !data ? <LoadingList label="載入中" rows={3} />
        : (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
            {data.installed.length ? (
              <ListGroup footer="改完之後，開著的 session 要重新啟動才會載入。" title="已安裝">
                {data.installed.map((p) => (
                  <li className={cn(rowClass, "py-0 pr-4")} key={p.id}>
                    <button
                      className="flex min-h-12 min-w-0 flex-1 items-center gap-3.5 py-2.5 text-left outline-none"
                      onClick={() => setSelected(p)}
                      type="button"
                    >
                      <PuzzlePiece aria-hidden className="size-5 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-base">{pluginName(p.id)}</span>
                        <span className="block truncate text-[0.8125rem] text-ink-muted">{[marketName(p.id), p.version].filter(Boolean).join(" · ")}</span>
                      </span>
                    </button>
                    <Switch
                      aria-label={`${pluginName(p.id)} ${p.enabled ? "已啟用" : "已停用"}`}
                      checked={p.enabled}
                      disabled={busy !== null}
                      onCheckedChange={(on) => void run(on ? "enable" : "disable", p)}
                    />
                  </li>
                ))}
              </ListGroup>
            ) : (
              <EmptyState description="從 marketplace 找一個來裝。" title="還沒有 plugin" />
            )}
            <ListGroup title="取得更多">
              <ListRow href="/plugins/browse" icon={<MagnifyingGlass />} label="瀏覽並安裝" />
              <ListRow href="/plugins/sources" icon={<Storefront />} label="Marketplace 來源" value={`${data.marketplaces.length} 個`} />
            </ListGroup>
          </div>
        )}

      <Sheet
        footer={selected ? (
          <>
            <Button disabled={busy !== null} onClick={() => setConfirmRemove(true)} variant="danger">解除安裝</Button>
            <Button onClick={() => void run("update", selected)} status={busy === `update:${selected.id}` ? "loading" : "idle"} variant="primary">更新</Button>
          </>
        ) : null}
        onOpenChange={(o) => { if (!o) setSelected(null); }}
        open={selected !== null}
        title={selected ? pluginName(selected.id) : ""}
      >
        {selected ? (
          <div className="pb-2">
            <ListGroup>
              <ListRow label="Marketplace" trailing={<span className="text-[0.9375rem] text-ink-muted">{marketName(selected.id)}</span>} />
              <ListRow label="版本" trailing={<span className="text-[0.9375rem] text-ink-muted">{selected.version ?? "—"}</span>} />
              <ListRow label="範圍" trailing={<span className="text-[0.9375rem] text-ink-muted">{selected.scope ?? "—"}</span>} />
            </ListGroup>
          </div>
        ) : null}
      </Sheet>

      <ConfirmDialog
        confirmLabel="解除安裝"
        description="開著的 session 重新啟動後就不會再載入它。"
        onConfirm={() => {
          const p = selected;
          setConfirmRemove(false);
          if (p) void run("uninstall", p).then((ok) => ok && setSelected(null));
        }}
        onOpenChange={setConfirmRemove}
        open={confirmRemove}
        title={`解除安裝 ${selected ? pluginName(selected.id) : ""}？`}
        tone="danger"
      />
    </div>
  );
}

// ---- Plugin › 瀏覽並安裝 ----

interface Available { id: string; name: string; description?: string; installed?: boolean }

export function PluginBrowsePage() {
  const [q, setQ] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const query = q.trim();

  const url = `/api/plugins/available?q=${encodeURIComponent(query)}`;
  const { data: results, error, reload: search } = useCached(url, () => get<{ plugins: Available[]; total: number }>(url), !!query, 300);

  async function install(p: Available) {
    setBusy(p.id);
    await runAction("install", p.id);
    if (query) await search();
    setBusy(null);
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <PageHeader back={{ href: "/plugins", label: "Plugin" }} title="瀏覽並安裝" />
      <label className="glass-control flex h-12 items-center gap-3 rounded-full border px-4 focus-within:border-[var(--focus-ring)]">
        <MagnifyingGlass aria-hidden className="size-5 shrink-0 text-ink-muted" />
        <input aria-label="搜尋 plugin" autoFocus className="min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-ink-faint" onChange={(e) => setQ(e.target.value)} placeholder="搜尋 marketplace 裡的 plugin" type="search" value={q} />
      </label>

      {error ? <ErrorState message={error} onRetry={search} retryLabel="重試" title="搜尋失敗" />
        : !query ? <p className="px-1 text-sm text-ink-faint">打字搜尋，例如 git、review、docs。</p>
        : !results ? <LoadingList label="搜尋中" rows={3} />
        : results.plugins.length ? (
          <ListGroup
            footer={results.total > results.plugins.length ? `顯示 ${results.plugins.length} / ${results.total} 個，打更多字縮小範圍。` : `${results.total} 個結果`}
          >
            {results.plugins.map((p) => (
              <li className={cn(rowClass, "items-start")} key={p.id}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base">{p.name}</span>
                  <span className="line-clamp-2 text-[0.8125rem] text-ink-muted">{p.description}</span>
                  <span className="block truncate text-xs text-ink-faint">{marketName(p.id)}</span>
                </span>
                {p.installed ? <span className="pt-1 text-sm text-ink-muted">已安裝</span> : (
                  <Button disabled={busy !== null && busy !== p.id} onClick={() => void install(p)} size="sm" status={busy === p.id ? "loading" : "idle"}>安裝</Button>
                )}
              </li>
            ))}
          </ListGroup>
        ) : <EmptyState description="換個關鍵字試試。" title="沒有符合的 plugin" />}
    </div>
  );
}

// ---- Plugin › Marketplace 來源 ----

export function PluginSourcesPage() {
  const { data, error, load } = usePlugins();
  const [addOpen, setAddOpen] = React.useState(false);
  const [selected, setSelected] = React.useState<Market | null>(null);
  const [confirmRemove, setConfirmRemove] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);

  async function run(action: string, name: string) {
    setBusy(action);
    const ok = await runAction(action, name);
    await load();
    setBusy(null);
    return ok;
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <PageHeader
        actions={<Button aria-label="加入 marketplace" onClick={() => setAddOpen(true)} size="icon" variant="primary"><Plus weight="bold" /></Button>}
        back={{ href: "/plugins", label: "Plugin" }}
        title="Marketplace 來源"
      />
      {error ? <ErrorState message={error} onRetry={() => void load()} retryLabel="重試" title="讀不到 marketplace" />
        : !data ? <LoadingList label="載入中" rows={2} />
        : (
          <ListGroup footer="瀏覽並安裝時會搜尋這些來源。">
            {data.marketplaces.map((m) => <ListRow detail={m.source} icon={<Storefront />} key={m.name} label={m.name} onClick={() => setSelected(m)} />)}
            <ListRow icon={<Plus />} label="加入 marketplace" onClick={() => setAddOpen(true)} />
          </ListGroup>
        )}

      <Sheet
        description={selected?.source}
        footer={selected ? (
          <>
            <Button disabled={busy !== null} onClick={() => setConfirmRemove(true)} variant="danger">移除</Button>
            <Button onClick={() => void run("marketplace-update", selected.name)} status={busy === "marketplace-update" ? "loading" : "idle"} variant="primary">更新</Button>
          </>
        ) : null}
        onOpenChange={(o) => { if (!o) setSelected(null); }}
        open={selected !== null}
        title={selected?.name ?? ""}
      >
        <p className="pb-2 text-[0.9375rem] text-ink-muted">更新會重新抓這個來源的 plugin 清單。</p>
      </Sheet>

      <ConfirmDialog
        confirmLabel="移除"
        description="從這個來源裝的 plugin 也可能一起被移除。"
        onConfirm={() => {
          const m = selected;
          setConfirmRemove(false);
          if (m) void run("marketplace-remove", m.name).then((ok) => ok && setSelected(null));
        }}
        onOpenChange={setConfirmRemove}
        open={confirmRemove}
        title={`移除 ${selected?.name ?? ""}？`}
        tone="danger"
      />

      <AddMarketSheet onAdd={(source) => run("marketplace-add", source)} onOpenChange={setAddOpen} open={addOpen} />
    </div>
  );
}

function AddMarketSheet({ onAdd, onOpenChange, open }: { onAdd: (source: string) => Promise<boolean>; onOpenChange: (o: boolean) => void; open: boolean }) {
  const [source, setSource] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { if (open) setSource(""); }, [open]);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    const ok = await onAdd(source.trim());
    setBusy(false);
    if (ok) onOpenChange(false);
  }
  return (
    <Sheet onOpenChange={onOpenChange} open={open} title="加入 marketplace">
      <form className="grid gap-4 pb-2" onSubmit={submit}>
        <Field hint="GitHub 的 owner/repo、網址，或電腦上的路徑。" label="來源">
          {({ describedBy, id }) => <Input aria-describedby={describedBy} autoFocus id={id} onChange={(e) => setSource(e.target.value)} placeholder="owner/repo" spellCheck={false} value={source} />}
        </Field>
        <Button disabled={!source.trim()} size="lg" status={busy ? "loading" : "idle"} type="submit" variant="primary">加入</Button>
      </form>
    </Sheet>
  );
}
