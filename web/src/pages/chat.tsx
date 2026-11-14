import * as React from "react";
import { toast } from "sonner";
import {
  ArrowClockwise, ArrowsInLineVertical, CaretLeft, DotsThree, GitBranch, PencilSimple,
  Sparkle, Terminal, Trash,
} from "@phosphor-icons/react/ssr";
import { del, get, post } from "@/lib/api";
import { goBack, navigate } from "@/lib/app-navigation";
import { cached, clearCache, refreshCached, setCached } from "@/lib/cache";
import { WINDOWS, baseName, tokens, until } from "@/lib/format";
import { conn, send, subscribe } from "@/lib/socket";
import { shared, TERMINAL_ONLY } from "@/lib/store";
import { useStore } from "@/lib/store-core";
import { addMessage, addNote, createTranscript, type Item, type Transcript } from "@/lib/transcript";
import { cn } from "@/lib/utils";
import { mergeTranscript, readLocalTranscript, removeLocalTranscript, restoreTranscript, saveLocalTranscript } from "@/lib/local-transcript";
import type { FirstPrompt, PickedImage } from "@/lib/prompt";
import { Composer } from "@/components/composer";
import { ComposerSettings } from "@/components/composer-settings";
import { Markdown } from "@/components/markdown";
import { openImage } from "@/components/lightbox";
import { SessionContext } from "@/lib/session-images";
import { forgetFiles } from "@/lib/file-mentions";
import { refreshPreview } from "@/lib/preview";
import { PermissionCard, type Answer, type PermissionRequest } from "@/components/permission-card";
import { ToolCard } from "@/components/tool-card";
import { FilesCard, TurnWork } from "@/components/turn";
import { turnRows, type FileChange } from "@/lib/turns";
import { prefs } from "@/lib/prefs";
import { Meter, UsageRing } from "@/components/usage-ring";
import { Button } from "@/ui/button";
import type { ActionStatus } from "@/ui/button";
import { ConfirmDialog } from "@/ui/confirm-dialog";
import { Dialog } from "@/ui/dialog";
import { EdgeBlur } from "@/ui/edge-blur";
import { Input } from "@/ui/field";
import { ListGroup, ListRow } from "@/ui/list";
import { ChoiceRow } from "@/ui/list-controls";
import { ErrorState } from "@/ui/page";
import { Sheet } from "@/ui/sheet";
import { useCompactViewport } from "@/ui/use-compact-viewport";
import { useVisualViewport } from "@/ui/use-visual-viewport";

interface Meta { id: string; cwd: string; title?: string; temporary?: boolean }
interface History { messages: unknown[]; start: number; total: number }
interface Context { used: number; threshold: number; max: number; categories?: { name: string; tokens: number }[] }
interface LiveState {
  status: string; open: boolean; draft: string; pending: PermissionRequest[]; mode: string; model: string | null;
  effort: string | null; context: Context | null; cost: { usd: number; added: number; removed: number } | null;
}
type SheetName = "options" | "window" | "usage" | "rename" | "remove" | null;


function historyTranscript(history: History | null): Transcript {
  const transcript = createTranscript();
  for (const message of history?.messages ?? []) addMessage(transcript, message);
  for (const item of transcript.items) item.calm = true;
  return transcript;
}

function addPrompt(transcript: Transcript, uuid: string, text: string, images: PickedImage[]) {
  const content = images.length ? [
    ...images.map(({ data, mediaType }) => ({ type: "image", source: { type: "base64", media_type: mediaType, data } })),
    ...(text ? [{ type: "text", text }] : []),
  ] : text;
  if (!images.length && text.startsWith("/")) {
    if (!transcript.seen.has(uuid)) transcript.items.push({ key: uuid, type: "note", text, command: true });
    transcript.seen.add(uuid);
  } else {
    addMessage(transcript, { uuid, message: { role: "user", content }, timestamp: new Date().toISOString() });
  }
}

function combineHistory(transcript: Transcript, history: History, prepend = false) {
  const fresh = historyTranscript(history);
  const items = mergeTranscript(transcript.items, fresh.items, prepend);
  for (const uuid of fresh.seen) transcript.seen.add(uuid);
  restoreTranscript(transcript, items);
}

export function ChatPage({ firstPrompt, id, onRename, slideIn }: { firstPrompt?: FirstPrompt; id: string; onRename: () => void; slideIn: boolean }) {
  const { controls, plan } = useStore(shared);
  const { online } = useStore(conn);
  const view = useStore(prefs);
  const sessionUrl = `/api/sessions/${id}`;
  const historyUrl = `${sessionUrl}/messages?limit=100`;
  const [meta, setMeta] = React.useState(() => cached<Meta>(sessionUrl));
  const [loadError, setLoadError] = React.useState("");
  const [initialHistory] = React.useState(() => cached<History>(historyUrl));
  const [initialTranscript] = React.useState(() => {
    const transcript = historyTranscript(initialHistory);
    if (firstPrompt) addPrompt(transcript, firstPrompt.id, firstPrompt.text, firstPrompt.images);
    return transcript;
  });
  const transcript = React.useRef(initialTranscript);
  const transcriptVersion = React.useRef(0);
  const [, setVersion] = React.useState(0);
  const [page, setPage] = React.useState({ start: initialHistory?.start ?? 0, total: initialHistory?.total ?? 0, loadingEarlier: false });
  // What each turn changed, by its prompt, as git counted it on the server.
  const [changes, setChanges] = React.useState<Record<string, FileChange[]>>({});
  const [s, setS] = React.useState<LiveState>({ status: firstPrompt ? "running" : "idle", open: false, draft: "", pending: [], mode: "default", model: null, effort: null, context: null, cost: null });
  const [effortAsk, setEffortAsk] = React.useState<string | null>(null); // effort waiting for a restart to be confirmed
  const [effortStatus, setEffortStatus] = React.useState<ActionStatus>("idle");
  const [text, setText] = React.useState("");
  const [sheet, setSheet] = React.useState<SheetName>(null);
  const [menuIndex, setMenuIndex] = React.useState(0);
  const [images, setImages] = React.useState<PickedImage[]>([]);
  const input = React.useRef<HTMLTextAreaElement>(null);
  const follow = React.useRef(!!initialHistory);
  // Whether new output should keep the view at the bottom: on while the reader sits at the
  // bottom, off as soon as they scroll up, back on when they return to the bottom.
  const stuck = React.useRef(true);
  const compact = useCompactViewport();
  const workspace = React.useRef<HTMLDivElement>(null);
  const scrollArea = React.useRef<HTMLDivElement>(null);
  const header = React.useRef<HTMLElement>(null);
  const composer = React.useRef<HTMLDivElement>(null);
  useVisualViewport(workspace, compact);

  React.useLayoutEffect(() => {
    const el = scrollArea.current;
    const shell = workspace.current;
    const topBar = header.current;
    const bottomBar = composer.current;
    if (!el || !shell || !topBar || !bottomBar) return;
    const updateBlur = () => {
      shell.style.setProperty("--chat-top-blur", String(Math.min(1, Math.max(0, el.scrollTop) / 48)));
      shell.style.setProperty("--chat-bottom-blur", String(Math.min(1, Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop) / 48)));
    };
    let lastTop = el.scrollTop;
    const onScroll = () => {
      const top = el.scrollTop;
      if (el.scrollHeight - top - el.clientHeight < 32) stuck.current = true;
      else if (top < lastTop - 1) stuck.current = false;
      lastTop = top;
      updateBlur();
    };
    const fitChrome = () => {
      shell.style.setProperty("--chat-header-height", `${topBar.offsetHeight}px`);
      shell.style.setProperty("--chat-composer-height", `${bottomBar.offsetHeight}px`);
      if (stuck.current) el.scrollTop = el.scrollHeight;
      updateBlur();
    };
    fitChrome();
    const observer = new ResizeObserver(fitChrome);
    observer.observe(el);
    observer.observe(topBar);
    observer.observe(bottomBar);
    const content = el.firstElementChild;
    const contentObserver = new ResizeObserver(updateBlur);
    if (content) contentObserver.observe(content);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => { observer.disconnect(); contentObserver.disconnect(); el.removeEventListener("scroll", onScroll); };
  }, []);

  const draftShown = React.useRef(false);
  React.useEffect(() => { draftShown.current = !!s.draft; });
  const t = transcript.current;
  const bump = React.useCallback((how: "force" | "near" | null = "near") => {
    if (how === "force") stuck.current = true;
    if (how && stuck.current) follow.current = true;
    setVersion((v) => v + 1);
  }, []);
  const archiveTimer = React.useRef<number>(undefined);
  const saveArchive = React.useCallback(() => {
    window.clearTimeout(archiveTimer.current);
    archiveTimer.current = undefined;
    void saveLocalTranscript(id, transcript.current.items).catch(() => {});
  }, [id]);
  const queueArchive = React.useCallback(() => {
    if (archiveTimer.current === undefined) archiveTimer.current = window.setTimeout(saveArchive, 250);
  }, [saveArchive]);
  React.useEffect(() => {
    window.addEventListener("pagehide", saveArchive);
    return () => {
      window.removeEventListener("pagehide", saveArchive);
      if (archiveTimer.current !== undefined) saveArchive();
    };
  }, [saveArchive]);
  const note = React.useCallback((textNote: string, extra: Partial<Item> = {}) => { addNote(t, textNote, extra); bump(); }, [t, bump]);

  // After each render that asked to follow, glide to the newest line. One frame loop eases
  // toward the bottom and keeps chasing it while output grows; scrolling up stops it.
  const glide = React.useRef(0);
  const jump = React.useRef(true);
  React.useLayoutEffect(() => {
    if (!follow.current) return;
    follow.current = false;
    const el = scrollArea.current;
    if (!el) return;
    if (jump.current || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      jump.current = false;
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (glide.current) return;
    const step = () => {
      const gap = el.scrollHeight - el.clientHeight - el.scrollTop;
      if (!stuck.current || gap < 1) { glide.current = 0; return; }
      el.scrollTop += Math.max(1, gap * 0.18);
      glide.current = requestAnimationFrame(step);
    };
    glide.current = requestAnimationFrame(step);
  });
  React.useEffect(() => () => cancelAnimationFrame(glide.current), []);

  const loadHistory = React.useCallback(() => refreshCached(historyUrl, () => get<History>(historyUrl)), [historyUrl]);
  const loadMeta = React.useCallback(() => refreshCached(sessionUrl, () => get<Meta>(sessionUrl)), [sessionUrl]);

  async function loadEarlier() {
    if (!page.start || page.loadingEarlier) return;
    const el = scrollArea.current;
    if (!el) return;
    const below = el.scrollHeight - el.scrollTop;
    const startAt = Math.max(0, page.start - 100);
    const url = `${sessionUrl}/messages?limit=${page.total - startAt}&before=${page.total}`;
    function show(history: History) {
      transcriptVersion.current++;
      stuck.current = false;
      follow.current = false;
      combineHistory(transcript.current, history, true);
      queueArchive();
      setPage((p) => ({ ...p, start: history.start, loadingEarlier: false }));
      requestAnimationFrame(() => { el.scrollTop = el.scrollHeight - below; });
    }
    const previous = cached<History>(url);
    if (previous) show(previous);
    else setPage((p) => ({ ...p, loadingEarlier: true }));
    const version = transcriptVersion.current;
    try {
      // Rebuild from the new start to the end in one read, so a tool and its result always meet.
      const fresh = await refreshCached(url, () => get<History>(url));
      if (!previous && version === transcriptVersion.current) show(fresh);
      else setPage((p) => ({ ...p, loadingEarlier: false }));
    } catch {
      setPage((p) => ({ ...p, loadingEarlier: false }));
    }
  }

  React.useEffect(() => {
    let snapshots = 0;
    let gone = false;
    let initialMessages: any[] | null = [];

    const localHistory = readLocalTranscript(id).then((items) => {
      if (gone || !items.length) return;
      restoreTranscript(transcript.current, mergeTranscript(items.map((item) => ({ ...item, calm: true })), transcript.current.items));
      bump();
    }).catch(() => {});

    const loadChanges = () => get<Record<string, FileChange[]>>(`${sessionUrl}/changes`)
      .then((c) => { if (!gone) setChanges(c); }).catch(() => {});
    void loadChanges();

    async function updateHistory(force = false) {
      void loadChanges();
      const version = transcriptVersion.current;
      const [history] = await Promise.all([loadHistory(), localHistory]);
      if (gone || version !== transcriptVersion.current) return;
      transcriptVersion.current++;
      combineHistory(transcript.current, history);
      queueArchive();
      setPage({ start: history.start, total: history.total, loadingEarlier: false });
      setLoadError("");
      if (force) jump.current = true;
      bump(force ? "force" : "near");
    }

    function onSdk(msg: any) {
      transcriptVersion.current++;
      const tr = transcript.current;
      if (msg.type === "assistant" || msg.type === "user") {
        if (msg.type === "assistant" && msg.parent_tool_use_id === null) setS((x) => ({ ...x, draft: "" }));
        const before = tr.items.length;
        addMessage(tr, msg.timestamp ? msg : { ...msg, timestamp: new Date().toISOString() }, { subagent: msg.parent_tool_use_id != null });
        // The streamed draft becomes this text: it is already on screen, so it does not rise again.
        if (msg.type === "assistant" && msg.parent_tool_use_id === null && draftShown.current) {
          for (const it of tr.items.slice(before)) if (it.type === "assistant") it.calm = true;
          draftShown.current = false;
        }
        queueArchive();
        bump();
      } else if (msg.type === "system" && msg.subtype === "compact_boundary") {
        const c = msg.compact_metadata ?? {};
        addNote(tr, `已壓縮對話${c.pre_tokens ? `（${tokens(c.pre_tokens)} → ${tokens(c.post_tokens)}）` : ""}`);
        saveArchive();
        bump();
      } else if (msg.type === "result") {
        setS((x) => ({ ...x, draft: "" }));
        // The title is made from the first prompt (or a summary) once the transcript exists.
        void loadMeta().then((r) => { if (!gone) setMeta(r); }).catch(() => {});
        void updateHistory().catch(() => {});
        if (msg.subtype !== "success" || msg.is_error) {
          addNote(tr, msg.subtype === "error_during_execution" ? "已中斷" : (msg.result || msg.errors?.join("\n") || msg.subtype), { error: msg.subtype !== "error_during_execution" });
        }
        saveArchive();
        bump();
      }
    }

    function onEvent(m: any) {
      switch (m.kind) {
        case "snapshot":
          setS((x) => ({ ...x, status: m.status, open: m.open, draft: m.draft, pending: m.pending, mode: m.permissionMode, model: m.model, effort: m.effort, context: m.context, cost: m.cost }));
          // After a reconnect the socket may have missed messages: read the transcript again.
          if (snapshots++ > 0) void updateHistory().catch(() => {});
          break;
        case "delta": setS((x) => ({ ...x, draft: x.draft + m.text })); bump(); break;
        case "sdk":
          if (initialMessages) initialMessages.push(m.msg);
          else onSdk(m.msg);
          break;
        case "changes":
          setChanges((c) => ({ ...c, [m.uuid]: m.files }));
          // Files the turn made or changed: check paths again, and reload what the panel shows.
          if (m.files.length) { forgetFiles(id); refreshPreview(); }
          break;
        case "status": setS((x) => ({ ...x, status: m.status, open: m.status === "running" ? true : x.open })); break;
        case "mode": setS((x) => ({ ...x, mode: m.permissionMode })); break;
        case "model": setS((x) => ({ ...x, model: m.model })); break;
        case "effort":
          setS((x) => ({ ...x, effort: m.effort }));
          setEffortAsk(null); setEffortStatus("idle");
          break;
        case "context": setS((x) => ({ ...x, context: m.context })); break;
        case "cost": setS((x) => ({ ...x, cost: m.cost })); break;
        case "permission": setS((x) => ({ ...x, pending: [...x.pending, m] })); bump(); break;
        case "permission-done": setS((x) => ({ ...x, pending: x.pending.filter((p) => p.id !== m.id) })); break;
        case "error": setEffortStatus("idle"); addNote(transcript.current, m.message, { error: true }); bump(); break;
        case "closed": setS((x) => ({ ...x, open: false, draft: "" })); break;
        default: break;
      }
    }

    const off = subscribe(id, onEvent);
    void loadMeta().then((m) => { if (!gone) setMeta(m); }).catch((e: Error) => {
      if (!gone && !cached<Meta>(sessionUrl)) setLoadError(e.message);
    });
    void updateHistory(!initialHistory).then(() => {
      if (gone) return;
      if (!transcript.current.items.length && matchMedia("(min-width: 48rem) and (pointer: fine)").matches) input.current?.focus({ preventScroll: true });
    }).catch(async (e: Error) => {
      await localHistory;
      if (!gone && !transcript.current.items.length) setLoadError(e.message);
    }).finally(() => {
      if (gone) return;
      const messages = initialMessages ?? [];
      initialMessages = null;
      for (const message of messages) onSdk(message);
    });
    return () => { gone = true; off(); };
  }, [id, initialHistory, sessionUrl, loadMeta, loadHistory, bump, queueArchive, saveArchive]);

  const running = s.status === "running";
  // Bubble mode can hide thinking and tools. The composer's stop button already says a turn is running.
  const hideWork = view.bubbles && view.hideWork;
  // Between steps (a tool done or a thought finished, the next not yet here) a shimmering 思考中
  // fills the gap; a tool at work shimmers on its own line, or here when bubble mode hides it.
  const busyTool = running ? t.items.findLast((it) => it.type === "tool" && !it.done) : undefined;
  const status = !running || s.draft || s.pending.length ? null : !busyTool ? "思考中" : hideWork ? `正在使用 ${busyTool.name}` : null;
  // A question waits at the bottom in place of the composer; other requests stay in the transcript.
  const question = s.pending.find((p) => p.tool === "AskUserQuestion");
  // The composer only rises back in after a question took its place, not on first load.
  const dockSwapped = React.useRef(false);
  if (question) dockSwapped.current = true;
  const contextPct = s.context?.threshold ? (s.context.used / s.context.threshold) * 100 : null;
  const title = meta?.title || (meta?.temporary ? "Temp Chat" : "新的 session");

  // ---- Composer and slash commands ----
  const slash = React.useMemo(() => {
    const m = text.match(/^\/(\S*)$/);
    if (!m) return [];
    const q = m[1].toLowerCase();
    return (controls?.commands ?? []).filter((c) => c.name.toLowerCase().includes(q))
      .sort((a, b) => (a.name.toLowerCase().startsWith(q) ? 0 : 1) - (b.name.toLowerCase().startsWith(q) ? 0 : 1) || a.name.localeCompare(b.name))
      .slice(0, 8);
  }, [text, controls]);
  React.useEffect(() => setMenuIndex(0), [slash.length]);

  function pick(name: string) {
    setText(`/${name} `);
    input.current?.focus();
  }

  function submit(raw = text) {
    const value = raw.trim();
    const fromBox = raw === text;
    const attached = fromBox ? images : [];
    if (!value && !attached.length) return;
    const name = attached.length ? undefined : value.match(/^\/(\S+)/)?.[1];
    if (name && name in TERMINAL_ONLY) {
      const where = TERMINAL_ONLY[name];
      addNote(t, where ? `/${name} 是終端機選單，請改用「${where}」頁。` : `/${name} 只能在終端機裡用。`, { error: true });
      if (fromBox) setText("");
      return bump("force");
    }
    const uuid = crypto.randomUUID();
    if (!send(id, { t: "send", uuid, text: value, images: attached.map(({ data, mediaType }) => ({ data, mediaType })) })) { note("沒有連線，訊息還留在輸入框。", { error: true }); return; }
    addPrompt(t, uuid, value, attached);
    saveArchive();
    if (fromBox) { setText(""); setImages([]); }
    setS((x) => ({ ...x, status: "running" }));
    bump("force");
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (slash.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setMenuIndex((menuIndex + 1) % slash.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setMenuIndex((menuIndex - 1 + slash.length) % slash.length); return; }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); pick(slash[menuIndex].name); return; }
    }
    // Enter sends on a computer; on a touch keyboard Enter is a new line and the button sends.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && matchMedia("(pointer: fine)").matches) { e.preventDefault(); submit(); }
    if (e.key === "Escape" && running) interrupt();
  }

  const interrupt = () => send(id, { t: "interrupt" });
  const answer = (req: PermissionRequest, a: Answer) => send(id, { t: "answer", id: req.id, ...a });

  // ---- Session actions ----
  async function fork() {
    try { const r = await post(`/api/sessions/${id}/fork`); setSheet(null); navigate(`/s/${r.id}`); } catch (e) { toast.error((e as Error).message); }
  }
  function restart() { send(id, { t: "restart" }); setSheet(null); note("Claude Code 已關閉，下一則訊息會重新啟動。"); }
  function command(cmd: string) { setSheet(null); submit(cmd); }
  async function copyResume() {
    try {
      await navigator.clipboard.writeText(`cd "${meta?.cwd}" && claude --resume ${id}`);
      toast.success("已複製接續指令");
    } catch { toast.error("無法複製"); }
  }

  const currentWindow = s.context?.max ? tokens(s.context.max) : null;

  return (
    <SessionContext.Provider value={id}>
    <div className={cn("fixed inset-x-0 top-[var(--visual-top,0px)] flex h-[var(--visual-height,100dvh)] flex-col md:left-[var(--desktop-inset)] motion-safe:transition-[left] motion-safe:duration-[var(--sidebar-motion,var(--motion-nav))] motion-safe:ease-[var(--ease-nav)]", slideIn && "chat-route-in")} ref={workspace}>
      <header className="pointer-events-none relative z-30 shrink-0 px-[var(--gutter)] pt-[calc(var(--safe-top)+0.5rem)] md:px-8 md:pt-4 [&>div]:pointer-events-auto" ref={header}>
        <div className="glass-float mx-auto flex max-w-3xl items-center gap-2 rounded-full p-1.5">
          <Button aria-label="返回" onClick={() => goBack("/")} size="icon" variant="ghost"><CaretLeft weight="bold" /></Button>
          <button className="min-w-0 flex-1 rounded-full px-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]" onClick={() => setSheet("options")} type="button">
            <h1 className="truncate text-[0.9375rem] font-semibold">{title}</h1>
            <p className="truncate text-[0.8125rem] text-ink-muted">
              {meta ? baseName(meta.cwd) : ""}
              {!online ? <span className="text-caution"> · 離線</span> : null}
            </p>
          </button>
          <UsageRing className="size-10 border-0 bg-transparent" label={`Context ${contextPct == null ? "尚無資料" : `${Math.round(contextPct)}%`}`} onClick={() => { send(id, { t: "usage" }); setSheet("usage"); }} pct={contextPct} />
          <Button aria-label="Session 選項" onClick={() => setSheet("options")} size="icon" variant="ghost"><DotsThree weight="bold" /></Button>
        </div>
      </header>
      <EdgeBlur className="chat-edge-blur absolute h-[calc(var(--chat-header-height,0px)+1.25rem)]" side="top" />
      <div className="absolute inset-0 overflow-y-auto overscroll-contain" ref={scrollArea}>
          <main className="mx-auto grid max-w-3xl grid-cols-[minmax(0,1fr)] gap-3.5 px-[var(--gutter)] pb-[calc(var(--chat-composer-height,0px)+1rem)] pt-[calc(var(--chat-header-height,0px)+1rem)] md:px-8">
            {loadError ? <ErrorState message={loadError} retryLabel="重試" title="打不開這個 session" /> : null}
            {page.start > 0 ? (
              <Button className="justify-self-center" onClick={() => void loadEarlier()} size="sm" status={page.loadingEarlier ? "loading" : "idle"} variant="ghost">載入更早的訊息</Button>
            ) : null}
            {(() => {
              const items = hideWork ? t.items.filter((it) => it.type !== "tool" && it.type !== "thinking") : t.items;
              if (!view.groupTools) return items.map((item) => <Entry bubbles={view.bubbles} item={item} key={item.key} />);
              return turnRows(items, running, changes).map((row) => row.kind === "work"
                ? <TurnWork end={row.end} items={row.items} key={row.key} live={row.live} start={row.start} />
                : row.kind === "files" ? <FilesCard files={row.files} key={row.key} />
                : <Entry bubbles={view.bubbles} item={row.item} key={row.item.key} />);
            })()}
            {s.draft ? <Markdown className={cn("content-in", view.bubbles && BUBBLE)} text={s.draft} /> : null}
            {s.pending.filter((p) => p !== question).map((p) => <PermissionCard key={p.id} onAnswer={(a) => answer(p, a)} req={p} />)}
            {status ? <p className="message-in justify-self-start text-[0.9375rem]" key={status} role="status"><span className="shimmer">{status}</span></p> : null}
          </main>
      </div>
      <EdgeBlur className="chat-edge-blur absolute h-[calc(var(--chat-composer-height,0px)+1.25rem)]" side="bottom" />
      <div className="pointer-events-none relative z-30 mt-auto shrink-0 px-[var(--gutter)] pb-[max(0.75rem,var(--safe-bottom))] md:px-8 md:pb-5 [&>div]:pointer-events-auto [&>form>div]:pointer-events-auto" ref={composer}>
      {question ? (
        <div className="mx-auto max-w-3xl">
          <PermissionCard className="max-h-[calc(var(--visual-height,100dvh)*0.65)] overflow-y-auto bg-surface-solid shadow-float" key={question.id} onAnswer={(a) => answer(question, a)} req={question} />
        </div>
      ) : (
      <form className={dockSwapped.current ? "content-in" : undefined} onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="relative mx-auto max-w-3xl">
          {slash.length ? (
            <div aria-label="指令" className="float-surface absolute inset-x-0 bottom-full mb-2 grid max-h-[min(20rem,calc(var(--visual-height,100dvh)*0.45))] overflow-y-auto rounded-panel border border-line bg-surface-solid p-1.5 shadow-float" data-state="open" role="listbox">
              {slash.map((c, i) => (
                <button
                  aria-selected={i === menuIndex}
                  className={cn("flex h-11 min-w-0 items-center gap-3 rounded-tile px-3 text-left outline-none", i === menuIndex && "bg-surface-raised")}
                  key={c.name}
                  onMouseDown={(e) => { e.preventDefault(); pick(c.name); }}
                  role="option"
                  type="button"
                >
                  <span className="shrink-0 font-mono text-sm">/{c.name}</span>
                  <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-ink-muted">{c.argumentHint || c.description}</span>
                </button>
              ))}
            </div>
          ) : null}
          <Composer images={images} input={input} onChange={setText} onImages={setImages} onInterrupt={running ? interrupt : undefined} onKeyDown={onKey} placeholder="輸入訊息，或 / 叫出指令" text={text}>
            <ComposerSettings disabled={!online} effort={s.effort ?? ""} effortLocked={running || effortStatus !== "idle"} mode={s.mode} model={s.model ?? ""}
              onEffort={(effort) => { if (effort === (s.effort ?? "")) return; if (s.open) setEffortAsk(effort); else send(id, { t: "effort", effort }); }} onMode={(mode) => send(id, { t: "mode", mode })} onModel={(model) => send(id, { t: "model", model })} />
          </Composer>
        </div>
      </form>
      )}
      </div>

      {/* Session options: what it runs with, then what can be done to it. */}
      <Sheet description={meta?.cwd} onOpenChange={(o) => setSheet(o ? "options" : null)} open={sheet === "options"} title={title}>
        <div className="grid gap-6 pb-2">
          <ListGroup title="執行設定">
            <ListRow icon={<ArrowsInLineVertical />} label="自動壓縮門檻" onClick={() => setSheet("window")} value={currentWindow ?? "—"} />
          </ListGroup>
          <ListGroup title="動作">
            <ListRow icon={<Sparkle />} label="壓縮對話" onClick={() => command("/compact")} />
            <ListRow icon={<GitBranch />} label="分支成新的 session" onClick={() => void fork()} />
            <ListRow icon={<PencilSimple />} label="改名" onClick={() => setSheet("rename")} />
            <ListRow disabled={!s.open} icon={<ArrowClockwise />} label="重新啟動 Claude Code" onClick={restart} value={s.open ? undefined : "未啟動"} />
            <ListRow icon={<Terminal />} label="複製電腦上的接續指令" onClick={() => void copyResume()} />
          </ListGroup>
          <ListGroup>
            <ListRow icon={<Trash />} label="從列表移除" onClick={() => setSheet("remove")} tone="danger" />
          </ListGroup>
        </div>
      </Sheet>

      <WindowSheet current={currentWindow} onOpenChange={(o) => setSheet(o ? "window" : null)} onPick={(size) => command(`/autocompact ${size}`)} open={sheet === "window"} />

      <Sheet onOpenChange={(o) => setSheet(o ? "usage" : null)} open={sheet === "usage"} title="用量">
        <div className="grid gap-6 pb-2">
          <div className="grid gap-5">
            <Meter
              label="Context"
              note={s.context ? `到 ${tokens(s.context.threshold)} 時自動壓縮（window ${tokens(s.context.max)}）` : "回覆一次之後才有資料。"}
              pct={contextPct}
              value={s.context ? `${tokens(s.context.used)} / ${tokens(s.context.threshold)}` : "—"}
            />
            {([["方案 5 小時", plan?.fiveHour], ["方案 7 天", plan?.sevenDay]] as const).map(([name, w]) => (
              <Meter key={name} label={name} note={w ? until(w.resetsAt) : undefined} pct={w?.pct ?? null} value={w ? `${Math.round(w.pct)}%` : "—"} />
            ))}
          </div>
          {s.context?.categories?.length ? (
            <ListGroup title="Context 組成">
              {s.context.categories.map((c) => <ListRow key={c.name} label={c.name} trailing={<span className="text-[0.9375rem] tabular-nums text-ink-muted">{tokens(c.tokens)}</span>} />)}
            </ListGroup>
          ) : null}
          {s.cost ? (
            <ListGroup title="這個 session（本次啟動）">
              <ListRow label="費用（等值）" trailing={<span className="text-[0.9375rem] tabular-nums text-ink-muted">${s.cost.usd.toFixed(2)}</span>} />
              <ListRow label="程式碼" trailing={<span className="text-[0.9375rem] tabular-nums text-ink-muted">+{s.cost.added} −{s.cost.removed}</span>} />
            </ListGroup>
          ) : null}
        </div>
      </Sheet>

      <RenameDialog
        initial={meta?.title ?? ""}
        onOpenChange={(o) => setSheet(o ? "rename" : null)}
        onSave={async (next) => {
          await post(`/api/sessions/${id}/rename`, { title: next });
          if (meta) {
            const renamed = { ...meta, title: next };
            setCached(sessionUrl, renamed);
            setMeta(renamed);
          }
          onRename();
          setSheet(null);
        }}
        open={sheet === "rename"}
      />

      <ConfirmDialog
        confirmLabel="重新啟動"
        description="Effort 只能在 Claude Code 啟動時設定。重新啟動後會接續這段對話，下一則訊息就會用新的 Effort。"
        onConfirm={() => { setEffortStatus("loading"); send(id, { t: "effort", effort: effortAsk ?? "", restart: true }); }}
        onOpenChange={(o) => { if (!o) setEffortAsk(null); }}
        open={effortAsk !== null}
        status={effortStatus}
        title={`把 Effort 改成 ${effortAsk || "預設"}？`}
      />

      <ConfirmDialog
        confirmLabel="移除"
        description="只是從 cc-remote 的列表拿掉，電腦上的紀錄檔會留著。"
        onConfirm={() => void del(sessionUrl).then(() => { window.clearTimeout(archiveTimer.current); archiveTimer.current = undefined; void removeLocalTranscript(id).catch(() => {}); clearCache(sessionUrl); navigate("/", { replace: true }); })}
        onOpenChange={(o) => setSheet(o ? "remove" : null)}
        open={sheet === "remove"}
        title="移除這個 session？"
        tone="danger"
      />
    </div>
    </SessionContext.Provider>
  );
}

const BUBBLE = "max-w-[92%] justify-self-start rounded-[1.25rem] rounded-bl-md bg-surface-solid px-4 py-2.5 shadow-panel";

function Entry({ bubbles, item }: { bubbles: boolean; item: Item }) {
  switch (item.type) {
    case "user":
      if (item.image) {
        const src = item.image;
        return (
          <button className="content-in max-w-[70%] cursor-zoom-in justify-self-end overflow-hidden rounded-[1.25rem]" onClick={() => openImage(src)} type="button">
            <img alt="" className="block max-h-64 object-cover" src={src} />
          </button>
        );
      }
      return (
        <div className={cn(!item.calm && "content-in", "max-w-[85%] justify-self-end whitespace-pre-wrap break-words rounded-[1.25rem] rounded-br-md bg-accent-soft px-4 py-2.5 text-[0.9375rem] leading-relaxed text-ink")} data-selectable="">
          {item.text}
        </div>
      );
    case "assistant":
      return <Markdown className={cn(!item.calm && "content-in", bubbles && BUBBLE)} text={item.text ?? ""} />;
    case "thinking":
    case "tool":
      return <ToolCard tool={item} />;
    default:
      return (
        <p className={cn("content-in justify-self-center whitespace-pre-wrap text-center text-[0.8125rem] text-ink-muted", item.error && "text-danger", item.command && "font-mono")}>
          {item.text}
        </p>
      );
  }
}

/** The auto-compact window for this session's model, sent as /autocompact. */
function WindowSheet({ current, onOpenChange, onPick, open }: { current: string | null; onOpenChange: (o: boolean) => void; onPick: (size: string) => void; open: boolean }) {
  const [custom, setCustom] = React.useState("");
  React.useEffect(() => { if (open) setCustom(""); }, [open]);
  return (
    <Sheet description="送出 /autocompact，跟在電腦上一樣永久改這個模型的門檻。" onOpenChange={onOpenChange} open={open} title="自動壓縮門檻">
      <div className="grid gap-5 pb-2">
        <ListGroup label="門檻" role="radiogroup">
          {WINDOWS.map((w) => <ChoiceRow key={w.value} label={w.label} onSelect={() => onPick(w.value)} selected={current === w.label} />)}
        </ListGroup>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (custom.trim()) onPick(custom.trim()); }}>
          <Input aria-label="自訂門檻" className="h-11" onChange={(e) => setCustom(e.target.value)} placeholder="自訂，例如 350k" value={custom} />
          <Button disabled={!custom.trim()} type="submit">套用</Button>
        </form>
      </div>
    </Sheet>
  );
}

function RenameDialog({ initial, onOpenChange, onSave, open }: { initial: string; onOpenChange: (o: boolean) => void; onSave: (title: string) => Promise<void>; open: boolean }) {
  const [value, setValue] = React.useState(initial);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  React.useEffect(() => { if (open) { setValue(initial); setError(""); } }, [open, initial]);
  async function save() {
    setBusy(true);
    try { await onSave(value.trim()); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog
      actions={
        <>
          <Button onClick={() => onOpenChange(false)}>取消</Button>
          <Button disabled={!value.trim()} onClick={() => void save()} status={busy ? "loading" : "idle"} variant="primary">儲存</Button>
        </>
      }
      onOpenChange={onOpenChange}
      open={open}
      title="改名"
    >
      <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); if (value.trim()) void save(); }}>
        <Input aria-label="新名稱" autoFocus onChange={(e) => setValue(e.target.value)} value={value} />
        {error ? <p className="message-in px-1 text-sm text-danger" role="alert">{error}</p> : null}
      </form>
    </Dialog>
  );
}
