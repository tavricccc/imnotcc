import * as React from "react";
import { CaretLeft, FolderOpen, FolderSimple, LinuxLogo, WindowsLogo } from "@phosphor-icons/react/ssr";
import { Composer } from "@/components/composer";
import { ComposerSettings, SettingButton } from "@/components/composer-settings";
import { goBack } from "@/lib/app-navigation";
import { useCached } from "@/lib/cache";
import { baseName } from "@/lib/format";
import { prefs } from "@/lib/prefs";
import type { FirstPrompt, PickedImage } from "@/lib/prompt";
import { useFolders, useSettings } from "@/lib/resources";
import { conn, SessionStartRejected, startSession } from "@/lib/socket";
import { TERMINAL_ONLY } from "@/lib/store";
import { useStore } from "@/lib/store-core";
import { Button } from "@/ui/button";
import { ListGroup, ListRow } from "@/ui/list";
import { ChoiceRow } from "@/ui/list-controls";
import { LoadingList } from "@/ui/page";
import { Sheet } from "@/ui/sheet";
import { useVisualViewport } from "@/ui/use-visual-viewport";
import { useCompactViewport } from "@/ui/use-compact-viewport";
import { ENV_LABEL, envOf, folderUrl, FolderBrowserSheet, readFolder, type Env } from "./sessions";

type Panel = "environment" | "project" | "browse";

export function NewSessionPage({ cwd, environment, onStarted }: {
  cwd?: string; environment?: Env; onStarted: (prompt: FirstPrompt) => void;
}) {
  const compact = useCompactViewport();
  const { sessionEnvironment } = useStore(prefs);
  const { data: roots, error: rootsError } = useCached(folderUrl(null), () => readFolder(null));
  const settings = useSettings();
  const [panel, setPanel] = React.useState<Panel | null>(null);
  const folders = useFolders(panel === "project");
  const [envChoice, setEnv] = React.useState<Env>();
  const [projectChoice, setProject] = React.useState<string | null>();
  const [modeChoice, setMode] = React.useState<string>();
  const [modelChoice, setModel] = React.useState<string>();
  const [effortChoice, setEffort] = React.useState<string>();
  const [text, setText] = React.useState("");
  const [images, setImages] = React.useState<PickedImage[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [awaitingReceipt, setAwaitingReceipt] = React.useState(false);
  const [error, setError] = React.useState("");
  const id = React.useRef<string>(null);
  const sending = React.useRef(false);
  const mounted = React.useRef(true);
  const input = React.useRef<HTMLTextAreaElement>(null);
  const page = React.useRef<HTMLElement>(null);
  const projectButton = React.useRef<HTMLButtonElement>(null);
  const nativePosix = !!roots?.home?.startsWith("/");
  const env = envChoice ?? (cwd ? envOf(cwd) : environment ?? (roots?.wslHome ? sessionEnvironment : nativePosix ? "wsl" : "win"));
  const availableEnvironments: Env[] = nativePosix ? ["wsl"] : roots?.wslHome || env === "wsl" ? ["win", "wsl"] : ["win"];
  const candidate = projectChoice === undefined ? cwd ?? settings.data?.folder : projectChoice;
  const project = candidate && envOf(candidate) === env ? candidate : null;
  const mode = modeChoice ?? settings.data?.permissionMode ?? "default";
  const model = modelChoice ?? settings.data?.model ?? "";
  const effort = effortChoice ?? settings.data?.effort ?? "";
  const known = [...new Set([...(project ? [project] : []), ...(folders.data ?? []).filter((folder) => envOf(folder) === env)])];
  const loadingDefaults = (!settings.data && !settings.error) || (!roots && !rootsError);
  const canSend = !loadingDefaults && !!(text.trim() || images.length);
  const locked = busy || awaitingReceipt;

  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  React.useEffect(() => {
    if (matchMedia("(min-width: 48rem) and (pointer: fine)").matches) input.current?.focus({ preventScroll: true });
  }, []);
  useVisualViewport(page, compact);

  function selectProject(path: string | null) {
    setProject(path);
    setPanel(null);
  }

  async function submit() {
    if (sending.current || !canSend) return;
    const value = text.trim();
    const command = !images.length && value.match(/^\/(\S+)/)?.[1];
    if (command && command in TERMINAL_ONLY) {
      const destination = TERMINAL_ONLY[command];
      setError(destination ? `/${command} 請到「${destination}」頁操作。` : `/${command} 只能在終端機裡用。`);
      return;
    }
    if (!conn.get().online) {
      setError("尚未連線，請再試一次。");
      return;
    }
    sending.current = true;
    setBusy(true);
    setError("");
    const prompt = { id: id.current ??= crypto.randomUUID(), text: value, images };
    try {
      await startSession(prompt.id, {
        ...(project ? { cwd: project } : { temporary: true, environment: env }),
        permissionMode: mode, model, effort, text: value,
        images: images.map(({ data, mediaType }) => ({ data, mediaType })),
      });
      if (mounted.current) {
        prefs.set({ sessionEnvironment: env });
        onStarted(prompt);
      }
    } catch (e) {
      setAwaitingReceipt(!(e instanceof SessionStartRejected));
      setError((e as Error).message);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  function setting(name: Panel, title: string, trigger: React.ReactElement, content: React.ReactNode) {
    return <Sheet onOpenChange={(open) => setPanel(open ? name : null)} open={panel === name} title={title} trigger={trigger}>{content}</Sheet>;
  }

  return (
    <main className="relative top-[var(--visual-top,0px)] mx-auto flex h-[var(--visual-height,100dvh)] min-h-0 max-w-3xl flex-col px-[var(--gutter)] pt-[var(--safe-top)] md:px-8" ref={page}>
      {compact ? (
        <header className="flex shrink-0 items-center gap-2 pt-2">
          <Button aria-label="返回 Session 清單" onClick={() => goBack("/")} size="icon" variant="ghost"><CaretLeft weight="bold" /></Button>
          <span className="text-base font-semibold">新增 Session</span>
        </header>
      ) : null}
      <div className="grid min-h-0 flex-1 content-center justify-items-center gap-3 overflow-hidden text-center">
        <img alt="" className="size-10 rounded-icon md:size-12" src="/icon.svg" />
        <h1 className="text-xl font-semibold md:text-3xl">想讓 Claude 做什麼？</h1>
      </div>
      <form className="relative pb-[max(0.75rem,var(--safe-bottom))] md:pb-5" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <div className="mx-3 flex min-w-0 items-center gap-1 rounded-t-panel bg-surface-raised px-2 pb-1 pt-1.5 md:mx-4">
          {setting("environment", "執行環境",
            <SettingButton aria-label={`執行環境：${ENV_LABEL[env]}`} disabled={locked}>{env === "win" ? <WindowsLogo /> : <LinuxLogo />}{ENV_LABEL[env]}</SettingButton>,
            <ListGroup label="執行環境" role="radiogroup">
              {availableEnvironments.map((value) => <ChoiceRow key={value} label={ENV_LABEL[value]} onSelect={() => {
                if (value !== env) { setEnv(value); setProject(null); }
                setPanel(null);
              }} selected={env === value} />)}
            </ListGroup>)}
          {setting("project", "專案目錄",
            <SettingButton aria-label={`專案目錄：${project ? baseName(project) : "Temp Chat"}`} disabled={locked} ref={projectButton}>
              <FolderSimple /><span className="truncate">{project ? baseName(project) : "Temp Chat"}</span>
            </SettingButton>,
            <div className="grid gap-4">
              <ListGroup label="專案目錄" role="radiogroup">
                <ChoiceRow detail="在臨時工作資料夾開始新對話" label="Temp Chat" onSelect={() => selectProject(null)} selected={!project} />
                {known.map((folder) => <ChoiceRow detail={<span className="break-all">{folder}</span>} key={folder} label={baseName(folder)} onSelect={() => selectProject(folder)} selected={project === folder} />)}
              </ListGroup>
              {!folders.data && !folders.error ? <LoadingList label="載入專案中" rows={2} /> : null}
              {folders.error ? <Button onClick={() => void folders.reload()} size="sm">重新載入專案</Button> : null}
              <ListGroup><ListRow icon={<FolderOpen />} label="瀏覽資料夾…" onClick={() => setPanel("browse")} /></ListGroup>
            </div>)}
        </div>
        <Composer busy={busy} disabled={!canSend} images={images} input={input} locked={locked} onChange={(value) => { setText(value); setError(""); }} onImages={setImages} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && matchMedia("(pointer: fine)").matches) {
            event.preventDefault();
            void submit();
          }
        }} placeholder="描述你想完成的事…" text={text}>
          <ComposerSettings disabled={locked} effort={effort} mode={mode} model={model} onEffort={setEffort} onMode={setMode} onModel={setModel} />
        </Composer>
        {error ? <p className="message-in px-3 pt-2 text-sm text-danger" role="alert">{error}</p> : null}
      </form>
      <FolderBrowserSheet env={env} onChoose={selectProject} onOpenChange={(open) => { if (!open) setPanel(null); }} onClosed={() => projectButton.current?.focus()} open={panel === "browse"} />
    </main>
  );
}
